import { z, type ZodTypeAny } from 'zod';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';

/**
 * OpenAPI 3.0's SchemaObject has no `const` and a narrower index signature than Zod
 * produces, so convert into a permissive alias and cast once at the export boundary.
 */
type MutableSchema = Record<string, unknown>;

/**
 * Derives the schema from the Zod schema that validates the route, so the two cannot
 * disagree. An unsupported node throws rather than emitting a wrong document.
 */
export class UnsupportedZodTypeError extends Error {
  constructor(public readonly path: string, public readonly node: ZodTypeAny) {
    super(
      `zodToOpenApiSchema: unsupported Zod node at "${path || '(root)'}". ` +
        `Extend zod-to-openapi.ts to cover ${node._def.typeName} before using it in a documented route.`,
    );
    this.name = 'UnsupportedZodTypeError';
  }
}

export function zodToOpenApiSchema(schema: ZodTypeAny): SchemaObject {
  return convert(schema, '') as SchemaObject;
}

/** A stable component name makes the schema reusable and $ref-able. */
export function zodToOpenApiComponent(schema: ZodTypeAny, name: string): SchemaObject {
  return { ...convert(schema, ''), title: name } as SchemaObject;
}

function convert(node: ZodTypeAny, path: string): MutableSchema {
  const def = node._def as { typeName: string } & Record<string, unknown>;

  switch (def.typeName) {
    case z.ZodFirstPartyTypeKind.ZodObject:
      return convertObject(node as z.ZodObject<z.ZodRawShape>, path);

    case z.ZodFirstPartyTypeKind.ZodString: {
      const checks = (def.checks ?? []) as { kind: string; value?: number }[];
      const out: MutableSchema = { type: 'string' };
      for (const check of checks) {
        if (check.kind === 'email') out.format = 'email';
        if (check.kind === 'min' && check.value !== undefined) out.minLength = check.value;
        if (check.kind === 'max' && check.value !== undefined) out.maxLength = check.value;
      }
      return out;
    }

    case z.ZodFirstPartyTypeKind.ZodNumber:
    case z.ZodFirstPartyTypeKind.ZodBigInt: {
      const checks = (def.checks ?? []) as { kind: string; value?: number }[];
      const out: MutableSchema =
        def.typeName === 'ZodBigInt' ? { type: 'integer', format: 'int64' } : { type: 'number' };
      for (const check of checks) {
        if (check.kind === 'int') out.type = 'integer';
        if (check.kind === 'min' && check.value !== undefined) out.minimum = check.value;
        if (check.kind === 'max' && check.value !== undefined) out.maximum = check.value;
      }
      return out;
    }

    case z.ZodFirstPartyTypeKind.ZodBoolean:
      return { type: 'boolean' };

    case z.ZodFirstPartyTypeKind.ZodEnum:
      return { type: 'string', enum: [...((def.values as string[]) ?? [])] };

    case z.ZodFirstPartyTypeKind.ZodLiteral:
      return { const: def.value };

    case z.ZodFirstPartyTypeKind.ZodArray: {
      const out: MutableSchema = {
        type: 'array',
        items: convert(def.type as ZodTypeAny, `${path}[]`),
      };
      const min = (def.minLength as { value: number } | null)?.value;
      const max = (def.maxLength as { value: number } | null)?.value;
      if (min !== undefined) out.minItems = min;
      if (max !== undefined) out.maxItems = max;
      return out;
    }

    // A transform or refine does not change the wire shape a client must send, so the
    // documented schema is the *input* schema.
    case z.ZodFirstPartyTypeKind.ZodEffects:
      return convert(def.schema as ZodTypeAny, path);

    case z.ZodFirstPartyTypeKind.ZodDefault: {
      const inner = convert(def.innerType as ZodTypeAny, path);
      const value = (def.defaultValue as () => unknown)();
      // Only JSON-representable defaults are advertised; anything else would emit "[object Object]".
      if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
        return { ...inner, default: value };
      }
      return inner;
    }

    // Peeled by convertObject; reaching here means it was nested somewhere unmodelled.
    case z.ZodFirstPartyTypeKind.ZodOptional:
    case z.ZodFirstPartyTypeKind.ZodNullable:
      throw new UnsupportedZodTypeError(path, node);

    default:
      throw new UnsupportedZodTypeError(path, node);
  }
}

function convertObject(node: z.ZodObject<z.ZodRawShape>, path: string): MutableSchema {
  const shape = node.shape;
  const properties: Record<string, MutableSchema> = {};
  const required: string[] = [];

  for (const [key, fieldSchema] of Object.entries(shape)) {
    const unwrapped = unwrapOptional(fieldSchema as ZodTypeAny);
    properties[key] = convert(unwrapped.schema, path ? `${path}.${key}` : key);
    if (!unwrapped.optional) required.push(key);
  }

  const out: MutableSchema = { type: 'object', properties };
  if (required.length > 0) out.required = required;
  return out;
}

/** Peels .optional()/.nullable() so requiredness is reported once, not threaded through every branch. */
function unwrapOptional(node: ZodTypeAny): { schema: ZodTypeAny; optional: boolean } {
  let current = node;
  let optional = false;

  // Bounded so a pathological schema cannot spin; Zod types are trees.
  for (let i = 0; i < 10; i += 1) {
    const kind = (current._def as { typeName: string }).typeName;
    if (kind === z.ZodFirstPartyTypeKind.ZodOptional) {
      optional = true;
      current = (current._def as { innerType: ZodTypeAny }).innerType;
      continue;
    }
    if (kind === z.ZodFirstPartyTypeKind.ZodNullable) {
      current = (current._def as { innerType: ZodTypeAny }).innerType;
      continue;
    }
    break;
  }

  return { schema: current, optional };
}
