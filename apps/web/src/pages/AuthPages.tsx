import { useMutation } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Button, Field, PageTitle, SelectField, errorMessage } from '../components/ui';
import { ApiError } from '../lib/api';
import { useAuth, type SignupRole } from '../lib/auth';

/** Only same-app paths are allowed as a post-login redirect. */
function useNext(): string {
  const [params] = useSearchParams();
  const next = params.get('next') ?? '/';
  return next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

function fieldErrors(error: unknown): Record<string, string> {
  if (!(error instanceof ApiError) || !Array.isArray(error.details)) return {};
  const out: Record<string, string> = {};
  for (const issue of error.details as { path?: string; message?: string }[]) {
    if (issue.path && issue.message) out[issue.path] = issue.message;
  }
  return out;
}

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const next = useNext();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const submit = useMutation({
    mutationFn: () => login(email, password),
    onSuccess: () => void navigate(next, { replace: true }),
  });
  const onSubmit = (e: FormEvent): void => {
    e.preventDefault();
    submit.mutate();
  };

  return (
    <div className="max-w-measure">
      <PageTitle>Sign in</PageTitle>
      <form onSubmit={onSubmit} className="flex flex-col gap-2" noValidate>
        <Field label="Email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <Field label="Password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        {submit.isError && (
          <p role="alert" className="text-accent-deep">
            {errorMessage(submit.error)}
          </p>
        )}
        <Button type="submit" disabled={submit.isPending} className="self-start">
          {submit.isPending ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
      <p className="mt-3 text-ink-soft">
        New here?{' '}
        <Link to={`/register?next=${encodeURIComponent(next)}`} className="font-bold text-ink underline underline-offset-4">
          Create an account
        </Link>
      </p>
    </div>
  );
}

export function RegisterPage() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const next = useNext();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [params] = useSearchParams();
  // "Sell tickets" links arrive with ?role=organizer preselected.
  const [role, setRole] = useState<SignupRole>(params.get('role') === 'organizer' ? 'organizer' : 'attendee');
  const submit = useMutation({
    mutationFn: () => register(email, password, role),
    onSuccess: (user) => void navigate(user.role === 'organizer' ? '/organizer' : next, { replace: true }),
  });
  const errors = fieldErrors(submit.error);
  const onSubmit = (e: FormEvent): void => {
    e.preventDefault();
    submit.mutate();
  };

  return (
    <div className="max-w-measure">
      <PageTitle>Create an account</PageTitle>
      <form onSubmit={onSubmit} className="flex flex-col gap-2" noValidate>
        <Field label="Email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} error={errors.email} />
        <Field
          label="Password"
          type="password"
          autoComplete="new-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={errors.password}
          hint="At least 8 characters."
        />
        <SelectField label="I want to" value={role} onChange={(e) => setRole(e.target.value as SignupRole)}>
          <option value="attendee">Buy tickets</option>
          <option value="organizer">Sell tickets for my events</option>
        </SelectField>
        {submit.isError && Object.keys(errors).length === 0 && (
          <p role="alert" className="text-accent-deep">
            {errorMessage(submit.error)}
          </p>
        )}
        <Button type="submit" disabled={submit.isPending} className="self-start">
          {submit.isPending ? 'Creating account…' : 'Create account'}
        </Button>
      </form>
    </div>
  );
}
