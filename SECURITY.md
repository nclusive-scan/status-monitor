# Security policy

## Supported versions

Only the latest release receives security fixes. Please upgrade to it before reporting, if you can.

## Reporting a vulnerability

Please **do not open a public issue** for a security problem. Report it privately through GitHub's private
vulnerability reporting: on this repository, open the **Security** tab and choose **Report a vulnerability**.

Please include:

- what an attacker can do, and what they need first (for example network access to the status page, a leaked key, or
  control of the watched platform);
- the steps or a proof of concept that reproduce it;
- the affected version or commit.

We aim to acknowledge a report within 3 business days and to agree on a disclosure date with you. Our default is
coordinated disclosure within 90 days. We credit reporters in the advisory unless they prefer otherwise.

## Scope

Examples of what is in scope:

- bypassing a signature check: the signed protocol ([spec/PROTOCOL.md](spec/PROTOCOL.md)), Twilio webhook signatures, or
  acknowledgement links;
- reading the operator view or contact details without the right key;
- making the monitor page the wrong people, stop paging, or silently drop alerts;
- any path by which the public status page reveals more than it is meant to show.

Out of scope: problems that need a Cloudflare, Twilio or GitHub account the attacker already controls on your behalf,
denial of service by traffic volume alone, and the known limitation that the monitor cannot see a Cloudflare-wide
outage (see "What this cannot detect" in the README).

Never include real patient data or other sensitive personal information in a report.
