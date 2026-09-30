import type { Metadata } from 'next';

import { RequireAnonymous } from '@/app/guards/require-anonymous';
import { SignInForm } from '@/features/auth/sign-in-form';

export const metadata: Metadata = { title: 'Create an account' };

export default function RegisterPage() {
  return (
    <RequireAnonymous>
      <main className="flex min-h-dvh items-center justify-center p-5">
        <div className="w-full max-w-sm">
          <SignInForm mode="register" />
        </div>
      </main>
    </RequireAnonymous>
  );
}
