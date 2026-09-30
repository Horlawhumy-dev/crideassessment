import { Field as FieldPrimitive } from '@base-ui/react/field';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

export function Field({ className, ...props }: ComponentProps<typeof FieldPrimitive.Root>) {
  return <FieldPrimitive.Root className={cn('flex flex-col gap-1.5', className)} {...props} />;
}

export function Label({ className, ...props }: ComponentProps<typeof FieldPrimitive.Label>) {
  return <FieldPrimitive.Label className={cn('text-sm font-medium', className)} {...props} />;
}

/**
 * `aria-invalid` is what ties the message to the input for a screen reader, and
 * it is set from `invalid` rather than from a prop the caller has to remember.
 * The previous forms set `aria-invalid` on some inputs and not others, so a
 * validation failure was announced on half the forms in the app.
 */
export function Input({ className, ...props }: ComponentProps<'input'>) {
  return (
    <input
      className={cn(
        'h-10 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm shadow-xs',
        'transition-[color,box-shadow] outline-none',
        'placeholder:text-muted-foreground',
        'focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40',
        'aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      className={cn(
        'min-h-20 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm shadow-xs',
        'transition-[color,box-shadow] outline-none placeholder:text-muted-foreground',
        'focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40',
        'aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20',
        className,
      )}
      {...props}
    />
  );
}

/**
 * A native `<select>`, styled.
 *
 * Deliberately not a custom listbox. A Base UI or Radix select is a div with
 * `role="combobox"`, which on a phone with a screen reader and a language
 * switcher installed is a worse experience than the platform control the user
 * already knows. The custom version would be a lot of code to be worse.
 */
export function Select({ className, children, ...props }: ComponentProps<'select'>) {
  return (
    <div className="relative">
      <select
        className={cn(
          'h-10 w-full appearance-none rounded-lg border border-input bg-background py-2 pr-9 pl-3 text-sm shadow-xs',
          'transition-[color,box-shadow] outline-none',
          'focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40',
          'aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20',
          'disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <svg
        aria-hidden
        viewBox="0 0 20 20"
        className="text-muted-foreground pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
      >
        <path d="m6 8 4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

/** The error text for a field. Rendered by Base UI's Field, so it is announced. */
export function FieldError({ className, ...props }: ComponentProps<typeof FieldPrimitive.Error>) {
  return <FieldPrimitive.Error className={cn('text-destructive text-xs font-medium', className)} {...props} />;
}

export function FieldDescription({ className, ...props }: ComponentProps<typeof FieldPrimitive.Description>) {
  return <FieldPrimitive.Description className={cn('text-muted-foreground text-xs', className)} {...props} />;
}
