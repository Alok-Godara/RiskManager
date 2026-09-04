import type { AuditEvent } from "../types/domain";

export function AuditLog({ events }: { events: AuditEvent[] }) {
  return (
    <div className="panel">
      <h2>Complete Audit Trail</h2>
      <ul className="audit-list">
        {events.slice(0, 100).map((a) => (
          <li key={a.id}>
            <span className="audit-time">{new Date(a.timestamp).toLocaleString()}</span>
            <span className="audit-type">{a.event_type}</span>
            <span>{a.description}</span>
          </li>
        ))}
        {events.length === 0 && <li className="muted">No events yet.</li>}
      </ul>
    </div>
  );
}
