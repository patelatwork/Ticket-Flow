import { Link } from 'react-router';
import { EmptyState } from '../components/ui';

export function NotFoundPage() {
  return (
    <EmptyState
      title="This page doesn’t exist"
      action={
        <Link to="/" className="font-bold underline underline-offset-4">
          Browse events
        </Link>
      }
    >
      The link may be old or mistyped.
    </EmptyState>
  );
}
