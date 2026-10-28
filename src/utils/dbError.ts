/**
 * A readable message for a failed save. Supabase errors are plain objects (not
 * Error instances), so `err.message` has to be picked out by hand; and when the
 * database lacks the transfer_out column (migration 012 not run yet) say exactly that.
 */
export function describeDbError(err: unknown, fallback: string): string {
  const message =
    err instanceof Error ? err.message : typeof err === "object" && err !== null && "message" in err ? String((err as { message: unknown }).message) : fallback;
  if (message.includes("transfer_out")) {
    return "The database doesn't have the \"transfer out\" column yet. Run supabase/migrations/012_execution_transfer_out.sql in the Supabase SQL editor, then try again.";
  }
  return message || fallback;
}
