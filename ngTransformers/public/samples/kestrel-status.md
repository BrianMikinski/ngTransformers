# Project Kestrel: status update

Driftwood Labs · data platform · updated end of Q3

## Summary

Kestrel replaces the nightly reporting batch with a streaming pipeline. The new ingestion service is live for
the North and West regions; South and East move over in Q4.

> Overall status: **amber**. On schedule, slightly over the hardware estimate.

## Budget

- Approved budget: $50,000
- Spent to date: $42,000
- Forecast at completion: $53,500 (cloud storage costs came in higher than planned)

## Incidents

- **KX-4471** (September 3rd): the reporting dashboard was down for six hours after a schema change dropped the
  `region` column. Root cause: no contract test between the ingestion service and the dashboard.
- **KX-4502** (September 19th): duplicate events during a deploy. Fixed by making the consumer idempotent.

## Team

- Priya: data platform lead, owns ingestion and storage
- Marco: owns the browser client and the dashboard
- Dana: finance partner, tracks the budget

## Next steps

1. Add contract tests between ingestion and the dashboard (Marco, October 15th)
2. Migrate the South and East regions (Priya, November)
3. Ask finance to approve the $3,500 overrun (Dana)

```sql
-- daily revenue check used by the dashboard
SELECT region, sum(revenue) FROM sales GROUP BY region;
```
