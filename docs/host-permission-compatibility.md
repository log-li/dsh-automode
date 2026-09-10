# Permission API compatibility

Recent Harness builds read effective permission state through host services:
`permissionPresets.current(session)`, `approval.effectivePolicy(session)`, and
`sandboxPolicy.resolve({ session })`. Automode prefers these services. It uses
the old event-fold helpers only when a legacy host actually exports them.

Named imports of `effectivePermissionPreset`, `effectiveApprovalPolicy`, and
`effectiveSandboxMode` prevent the entire plugin from loading on current hosts.
Namespace imports in `src/permissions.ts` allow feature detection without
inventing state from an incomplete event log. Service errors propagate; both
enforcement points reject when the active preset cannot be determined. On
modern hosts a failed preset setter is not bypassed with raw event writes.

Validation commands:

```
npm run build
npm test
npm run test:flow
npm run test:permissions
```

To exercise the compiled plugin against a separate extracted host, set
`DSH_AUTOMODE_TEST_HOST_MODULES` to that host's `app/node_modules` directory and
run `node --import ./scripts/host-modules-hook.mjs --test scripts/permissions.test.mjs`.
The adapter changes only module resolution in the test process.

Verified locally on Windows with Portable 0.6.4 (official permission-presets
0.1.2-rc.1) and a local 0.6.5-rc.2 artifact (0.1.3-alpha.2): installation followed
by restart loads the patched plugin and both existing default plugins. These
checks do not exercise a paid model or prove every auto-approval scenario.
