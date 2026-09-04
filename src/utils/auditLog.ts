import { v4 as uuid } from "uuid";
import { repository } from "../data";
import type { AuditEvent } from "../types/domain";

/** Shared helper for settings screens (Instruments, Structure Templates) to
 * append an audit event without needing a dedicated engine. */
export async function logAudit(event: Omit<AuditEvent, "id" | "timestamp">) {
  const full: AuditEvent = { ...event, id: uuid(), timestamp: new Date().toISOString() };
  await repository.addAuditEvent(full);
}
