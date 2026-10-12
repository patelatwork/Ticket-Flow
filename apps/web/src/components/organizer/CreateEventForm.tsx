import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api } from '../../lib/api';
import type { EventSummary } from '../../lib/types';
import { Button, Field, errorMessage } from '../ui';

export function CreateEventForm() {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const [venue, setVenue] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [description, setDescription] = useState('');

  const create = useMutation({
    mutationFn: () =>
      api<{ event: EventSummary }>('/events', {
        method: 'POST',
        // datetime-local is the organizer's local time; send it as an absolute instant.
        body: { title, venue, description, startsAt: new Date(startsAt).toISOString() },
      }),
    onSuccess: () => {
      setTitle('');
      setVenue('');
      setStartsAt('');
      setDescription('');
      void queryClient.invalidateQueries({ queryKey: ['my-events'] });
    },
  });

  const onSubmit = (e: FormEvent): void => {
    e.preventDefault();
    create.mutate();
  };

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-2 max-w-measure" aria-labelledby="create-event-heading">
      <h2 id="create-event-heading" className="text-xl font-bold">
        New event
      </h2>
      <Field label="Title" required value={title} onChange={(e) => setTitle(e.target.value)} />
      <Field label="Venue" required value={venue} onChange={(e) => setVenue(e.target.value)} />
      <Field label="Starts at" type="datetime-local" required value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
      <Field label="Description" value={description} onChange={(e) => setDescription(e.target.value)} hint="Optional. Shown above the seat map." />
      {create.isError && (
        <p role="alert" className="text-accent-deep">
          {errorMessage(create.error)}
        </p>
      )}
      {create.isSuccess && (
        <p role="status" className="text-go font-bold">
          Draft created. Add a seat layout below, then publish it.
        </p>
      )}
      <Button type="submit" disabled={create.isPending || !title || !venue || !startsAt} className="self-start">
        {create.isPending ? 'Creating…' : 'Create draft'}
      </Button>
    </form>
  );
}
