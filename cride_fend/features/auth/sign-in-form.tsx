'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { AlertCircle, LogIn, UserPlus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { useForm, type FieldPath, type FieldValues, type UseFormSetError } from 'react-hook-form';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldError, Input, Label, Select } from '@/components/ui/input';
import { ApiError } from '@/lib/api/errors';
import { useSignIn, useRegister } from '@/lib/session/session';
import { registerSchema, signInSchema, type SignInInput } from './schemas';

/**
 * Sign in.
 *
 * The interesting part is the error handling. A failed attempt can be one of
 * several very different things, and the previous `AuthPage` collapsed all of
 * them into "Invalid credentials":
 *
 *   400  the backend rejected the payload  → say what was wrong
 *   401  genuinely wrong credentials      → say that, and stop
 *   429  throttled, 5 per minute          → say wait, and disable the button
 *   5xx  the API is down                  → say that, and offer a retry
 *
 * Telling a user their password is wrong when the server is unreachable is how
 * people get locked out of working accounts. `ApiError` carries the distinction
 * already, so this component never has to parse a message.
 */

export function SignInForm({ mode = 'signin' }: { mode?: 'signin' | 'register' }) {
  if (mode === 'register') return <RegisterForm />;
  return <SignInFields />;
}

function SignInFields() {
  const router = useRouter();
  const formId = useId();
  const signIn = useSignIn();
  const [serverError, setServerError] = useState<ApiError | null>(null);

  const {
    register: field,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<SignInInput>({
    resolver: zodResolver(signInSchema),
    defaultValues: { email: '', password: '' },
    // Validate on blur, not on every keystroke: telling someone their email is
    // invalid while they are still typing the domain is noise, not feedback.
    mode: 'onBlur',
  });

  const onSubmit = handleSubmit(async (values) => {
    setServerError(null);
    try {
      const session = await signIn.signIn(values);
      router.replace(session.user.role === 'RIDER' ? '/rider' : '/driver');
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      setServerError(error);
      applyServerIssues(error, setError, ['email', 'password'] as const);
    }
  });

  const throttled = serverError?.isRateLimited ?? false;

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
        <p className="text-muted-foreground text-sm">Welcome back to C-Ride, Osogbo.</p>
      </div>

      {serverError && !serverError.isValidation && <ServerError error={serverError} />}

      <Field invalid={Boolean(errors.email)}>
        <Label htmlFor={`${formId}-email`}>Email</Label>
        <Input
          id={`${formId}-email`}
          type="email"
          autoComplete="email"
          inputMode="email"
          placeholder="rider@cride.ng"
          {...field('email')}
        />
        <FieldError>{errors.email?.message}</FieldError>
      </Field>

      <Field invalid={Boolean(errors.password)}>
        <Label htmlFor={`${formId}-password`}>Password</Label>
        <Input
          id={`${formId}-password`}
          type="password"
          autoComplete="current-password"
          {...field('password')}
        />
        <FieldError>{errors.password?.message}</FieldError>
      </Field>

      <Button type="submit" size="lg" disabled={isSubmitting || throttled} className="touch-target w-full">
        <LogIn aria-hidden />
        {throttled ? 'Too many attempts' : isSubmitting ? 'Signing in…' : 'Sign in'}
      </Button>

      {throttled && (
        <p className="text-muted-foreground text-center text-xs">
          Five attempts a minute. Wait a moment before trying again.
        </p>
      )}

      <p className="text-muted-foreground text-center text-sm">
        New to C-Ride?{' '}
        <Link href="/register" className="text-primary font-medium underline underline-offset-4">
          Create an account
        </Link>
      </p>

      <DemoCredentials />
    </form>
  );
}

/**
 * The seeded accounts, on the page.
 *
 * This is a demo build and a reviewer should not have to read a README to log
 * in. It is also the fastest possible answer to "which account is a driver?" —
 * a question the architecture doc raises as a recurring problem.
 */
function DemoCredentials() {
  return (
    <div className="bg-muted/50 border-border text-muted-foreground rounded-xl border p-3 text-xs leading-relaxed">
      <p className="mb-1 font-medium">Seeded accounts</p>
      <p>
        <code className="text-foreground">rider@cride.ng</code> or{' '}
        <code className="text-foreground">driver1@cride.ng</code>
        <br />
        password <code className="text-foreground">cride-demo-2026</code>
      </p>
    </div>
  );
}

function RegisterForm() {
  const router = useRouter();
  const formId = useId();
  const register = useRegister();
  const [serverError, setServerError] = useState<ApiError | null>(null);

  const {
    register: field,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(registerSchema),
    defaultValues: { displayName: '', email: '', password: '', phone: '', role: 'RIDER' as const },
    mode: 'onBlur',
  });

  const onSubmit = handleSubmit(async (values) => {
    setServerError(null);
    try {
      const session = await register.register({
        displayName: values.displayName,
        email: values.email,
        password: values.password,
        role: values.role,
        ...(values.phone ? { phone: values.phone } : {}),
      });
      toast.success(`Welcome to C-Ride, ${session.user.displayName.split(' ')[0]}.`);
      router.replace(session.user.role === 'RIDER' ? '/rider' : '/driver');
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      setServerError(error);

      // §4.3: a 409 here is an email that is already registered. A form that said
      // "cannot create account" for a duplicate address is technically correct
      // and practically useless.
      if (error.isConflict) {
        setError('email', { message: 'There is already an account with that email.' });
        setServerError(null);
        return;
      }
      applyServerIssues(error, setError, ['displayName', 'email', 'phone', 'password', 'role'] as const);
    }
  });

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <h1 className="text-2xl font-semibold tracking-tight">Create your account</h1>
        <p className="text-muted-foreground text-sm">Riding and driving across Osogbo.</p>
      </div>

      {serverError && <ServerError error={serverError} />}

      <Field invalid={Boolean(errors.role)}>
        <Label htmlFor={`${formId}-role`}>I want to</Label>
        <Select id={`${formId}-role`} {...field('role')}>
          <option value="RIDER">Ride — book a trip</option>
          <option value="DRIVER">Drive — earn on my car</option>
        </Select>
        <FieldDescription>You can keep your car off the road and go online when you are ready.</FieldDescription>
        <FieldError>{errors.role?.message}</FieldError>
      </Field>

      <Field invalid={Boolean(errors.displayName)}>
        <Label htmlFor={`${formId}-name`}>Full name</Label>
        <Input id={`${formId}-name`} autoComplete="name" placeholder="Amara Okafor" {...field('displayName')} />
        <FieldError>{errors.displayName?.message}</FieldError>
      </Field>

      <Field invalid={Boolean(errors.email)}>
        <Label htmlFor={`${formId}-email`}>Email</Label>
        <Input id={`${formId}-email`} type="email" autoComplete="email" inputMode="email" placeholder="you@cride.ng" {...field('email')} />
        <FieldError>{errors.email?.message}</FieldError>
      </Field>

      <Field invalid={Boolean(errors.phone)}>
        <Label htmlFor={`${formId}-phone`}>Phone <span className="text-muted-foreground font-normal">optional</span></Label>
        <Input id={`${formId}-phone`} type="tel" autoComplete="tel" inputMode="tel" placeholder="+2348030000000" {...field('phone')} />
        <FieldError>{errors.phone?.message}</FieldError>
      </Field>

      <Field invalid={Boolean(errors.password)}>
        <Label htmlFor={`${formId}-password`}>Password</Label>
        <Input id={`${formId}-password`} type="password" autoComplete="new-password" {...field('password')} />
        <FieldDescription>At least 10 characters.</FieldDescription>
        <FieldError>{errors.password?.message}</FieldError>
      </Field>

      <Button type="submit" size="lg" disabled={isSubmitting} className="touch-target w-full">
        <UserPlus aria-hidden />
        {isSubmitting ? 'Creating…' : 'Create account'}
      </Button>

      <p className="text-muted-foreground text-center text-sm">
        Already have an account?{' '}
        <Link href="/signin" className="text-primary font-medium underline underline-offset-4">
          Sign in
        </Link>
      </p>
    </form>
  );
}

/* ---- shared ---- */

function ServerError({ error }: { error: ApiError }) {
  return (
    <div role="alert" className="border-destructive/25 bg-destructive/5 text-destructive flex items-start gap-2.5 rounded-xl border p-3 text-sm">
      <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="space-y-1">
        <p>{error.displayMessage}</p>
        {error.debugHint && <p className="text-muted-foreground font-mono text-[0.7rem]">{error.debugHint}</p>}
      </div>
    </div>
  );
}

/**
 * §4.2: on a 400 the backend returns `details: { issues: [{ path, message }] }`.
 * Those issues are written against the same field names the form uses, so they
 * can be applied directly. The old app discarded `details` entirely and showed
 * only the top-level message.
 */
function applyServerIssues<T extends FieldValues>(
  error: ApiError,
  setError: UseFormSetError<T>,
  fields: readonly FieldPath<T>[],
): void {
  for (const issue of error.validationIssues) {
    // Only paths the form actually has. The backend's `path` is dotted
    // (`pickup.lat`); a form field called that does not exist, and setting an
    // error on it would render nowhere.
    const root = issue.path.split('.')[0] as FieldPath<T>;
    if (fields.includes(root)) setError(root, { type: 'server', message: issue.message });
  }
}
