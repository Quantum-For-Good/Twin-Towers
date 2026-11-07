export function assertDisposableDatabaseUrl(value: string): void {
  const parsed = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) ||
      parsed.hostname !== '127.0.0.1' || parsed.port !== '5433' ||
      parsed.pathname !== '/kicks_disposable_test' || parsed.search || parsed.hash) {
    throw new Error('disposable_database_url_must_target_127.0.0.1_5433_kicks_disposable_test');
  }
}
