# Contributing

Thank you for helping. Issues and pull requests are welcome.

## Set up and check

```sh
npm ci
npm run check            # typecheck, lint and the unit tests
npm run dry-run          # bundles the monitor Worker; deploys nothing
npm run dry-run:status-page
```

Node.js 24.20 or later (below 25) is required. CI runs the same commands on every pull request, and they must pass.

## Ground rules

- **Never call real providers from a test or a local run.** Tests use fakes. For `wrangler dev`, set
  `DELIVERY_MODE=log` (or `--var DELIVERY_MODE:log`), which records every delivery without sending anything.
- **No PHI or real personal data, anywhere.** Fixtures, examples, issues and screenshots use RFC 2606 names
  (`example.com`, `example.test`) and the reserved test numbers `+15555550100` to `+15555550199` only. The one
  exception is Twilio's published webhook-signature examples in `test/security.test.ts`, whose URL and numbers are
  Twilio's own inputs and must stay as published. Never commit credentials, and never commit a real escalation policy.
- **Keep the protocol stable.** A change to the canonical string, the headers, the key rules or
  `spec/vectors/signature-v2.json` is a new protocol version. Discuss it in an issue first.
- **Keep it failing closed.** A new setting must be validated in `worker/config.ts`, and an invalid value must refuse
  the run rather than be guessed at.
- Add or update tests with every behaviour change, and update the README when a setting or a behaviour that operators
  see changes.

## Pull requests

Keep each pull request to one change, describe what it changes and why, and say how you tested it. By contributing,
you agree that your contribution is licensed under the [Apache License 2.0](LICENSE).
