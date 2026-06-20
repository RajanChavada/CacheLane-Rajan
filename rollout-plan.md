# Cost Dashboard — Rollout Plan

## Ship Checklist

- [ ] All tasks in `implementation-plan.md` complete
- [ ] `npm test` passes
- [ ] `npm run lint` passes
- [ ] `npx tsc --noEmit` passes
- [ ] Manual browser test passes (see testing-plan.md)
- [ ] PR reviewed and approved

## No Storage Schema Changes

Reads existing DB only. No migrations.

## No Config Schema Changes

Port is a CLI flag, not a persisted config field.

## User-Visible Changes

- `cachelane dashboard` is a new command (additive)
- No changes to existing CLI commands

## Documentation Updates

- **README.md:** Add `cachelane dashboard` to the "Commands" section with a screenshot
- **`app/docs/cli-reference/page.tsx`:** Add `dashboard` command docs
- Consider adding a GIF/screenshot of the dashboard to the README — high impact for first impressions

## Rollback

Additive feature — revert PR removes the command. No user data affected. The `npm run build` output is the only deployment artifact.
