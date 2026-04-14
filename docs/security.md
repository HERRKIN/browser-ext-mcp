# Security

## Short Answer

For a local-first product, an account password is not strictly necessary for v1.

The real problem here is not internet identity. The real problem is local tampering:

- prevent another local process from taking over the relay
- prevent a website from talking directly to the bridge
- prevent tabs outside the workspace from being controlled
- require approval for sensitive actions

## The Problem We Are Solving

Claude asks for login because Claude in Chrome is tied to an account system, paid plans, organization policies, and Anthropic cloud services.

This project starts from a different place. The first problem is not remote user authentication. The first problem is local tampering around a browser bridge running on the same machine.

## Recommended v1 Security Model

Current repo status:

- relay bound to `127.0.0.1` only
- ephemeral session token for local bridge-extension pairing
- basic `Origin` and `Host` validation in the relay
- inactivity expiration and token rotation on re-pairing
- `/pull` and `/result` require `Authorization: Bearer ...`
- execution scoped to the active workspace

Current limitations:

- this pairing model helps against casual or unauthenticated local access, not against local malware or token theft on a compromised machine
- it is still a local mechanism, not a full user-identity system

## Release Posture Right Now

For the current repo state, the honest public claim is:

- local-first and mechanically guarded
- usable today by technical users
- not yet minimized to the strictest possible extension-permission model
- not designed as a hardened multi-user security boundary

That distinction matters. The current implementation is strong enough for an open repository and local use, but some hardening ideas are still intentionally tracked as future work rather than current guarantees.

## Hardening Still Pending

Before this should be described as a more security-hardened release, the following gaps should stay explicit:

- the extension still requests broad page access because the current browser-control model depends on site-wide execution and a global content script
- `optional_host_permissions` is still a future reduction step, not something implemented today
- the approval model is real but still basic; it is not yet a full user-presence or policy engine
- the offscreen relay event stream uses a local token in the event URL because `EventSource` cannot send custom auth headers; this is acceptable in the current local-first model but should not be overstated as a strong remote-style security primitive
- artifact storage can contain sensitive page data and should be treated as local debugging state, not as sanitized output

## Do Not Do This

- do not expose the relay on an open network interface
- do not accept requests without local authentication
- do not assume "localhost means secure"
- do not treat `nativeMessaging` as a substitute for authentication
- do not hardcode a fixed password

## Do This Instead

- bind the relay only to `127.0.0.1`
- use an ephemeral pairing token between bridge and extension
- expire the token by time or on session end
- validate `Origin` and `Host`
- only accept commands from the paired bridge
- scope execution to the active workspace
- require explicit human approval in the side panel for sensitive actions

## Recommended Layered Model

### Layer 1. Local Pairing

When the bridge starts:

- generate a `session_id`
- generate a high-entropy `pairing_secret`
- expose or store that secret only locally

When the extension connects:

- request pairing
- receive a challenge
- sign or relay the token according to the local protocol
- become the authorized extension session for that bridge

### Layer 2. Session Token

After pairing:

- the bridge issues an ephemeral token
- the extension sends that token with each relay request
- the relay rejects requests without a valid token

### Layer 3. Execution Scope

Even with a valid token:

- the command must belong to the active workspace
- the site must be allowed
- the action cannot belong to a blocked category without approval

### Layer 4. Human Approval

High-risk actions:

- should require user presence
- should ideally require approval in the side panel
- may later support an optional local passphrase or OS biometrics

## Do We Need A Password?

### Technical Answer

Not as a base requirement for v1.

For a local single-user tool, adding a product-specific password too early creates friction and often gives a false sense of security if the relay itself is still weak.

The first priorities should be:

- ephemeral pairing
- session expiration
- approval flow
- site permissions
- workspace scoping

### When A Local Passphrase Might Make Sense

- if the bridge is expected to stay running all the time
- if multiple operating-system users share the same machine
- if you want to protect reopening persisted sessions
- if you want an explicit "unlock sensitive actions" step

In that case, the passphrase should be an extra layer, not the primary defense.

## Minimal Threat Model

We want to mitigate:

- another local app trying to hit the relay
- a website attempting loopback/CORS abuse against the bridge
- prompt injection coming from web content
- accidental automation on the wrong tabs
- irreversible actions without supervision

We do not expect to fully solve in v1:

- malware with full control of the user's machine
- session theft on an already-compromised operating system
- universal bypass of third-party anti-bot defenses

## Recommended Product Decision

For this project, the practical sequence is:

### v1

- no account login
- no mandatory password
- ephemeral local pairing
- loopback-only relay
- approval flow for high-risk actions
- site permissions and workspace scoping

### v2

- optional `workspace lock`
- persisted sessions with optional local unlock
- automatic token rotation improvements

### v3

- optional local passphrase
- integration with system keychain or biometrics if it genuinely improves security

## Product Choice Still Open

There is one meaningful product choice to make:

- `fluid mode`: no password, local pairing plus visible approvals
- `hardened mode`: same foundation, plus explicit unlock for sensitive actions or persisted sessions

The recommended starting point is `fluid mode`, because it keeps the product usable while the core workflow is still being refined.

## Potential Security Improvements

These ideas are intentionally documented as future hardening work, not as current guarantees.

### Keep The Extension Mechanically Conservative

The extension should not try to "understand" user intent the way a model does. If the page contains prompt injection, the model may already be compromised for that step.

That means the extension should only enforce simple, mechanical guardrails that do not depend on trusting model reasoning:

- field type checks such as `password`, `file`, and other structurally sensitive inputs
- button and form mechanics such as `type="submit"`
- dangerous key combinations such as `Enter`, `Meta`, or `Control` shortcuts
- site-level policy decisions such as `allow`, `ask`, and `block`
- workspace scoping and tab ownership

### Do Not Approve Everything

Making every action require approval would make the product unusable.

The better direction is to keep low-risk flows smooth while adding friction only at the dangerous edges:

- allow read-only inspection, navigation, screenshots, scrolling, and hover by default
- allow low-risk interactions such as search bars, filters, and ordinary browsing controls
- require approval for file uploads, credential entry, clearly destructive actions, and likely submit/confirm steps
- consider approvals for risky keyboard actions rather than every keypress

### Prefer Structural Heuristics Over Semantic Guessing

Future hardening should be based on page structure and input mechanics, not on broad semantic claims such as "this looks like ecommerce" or "this seems safe."

Examples of safer heuristics:

- trust `input[type="search"]` more than a generic text field
- treat `input[type="password"]` as sensitive without asking the model
- treat upload controls as sensitive regardless of page copy
- treat submit buttons, destructive labels, and confirmation dialogs as higher risk than ordinary links

### Improve Pairing And Local Session Ownership

The current loopback pairing model is useful, but future versions should further reduce the chance that another local process can reuse or steal a session:

- stronger one-time pairing semantics
- tighter ownership of the first successful extension session
- optional local unlock for persisted or long-lived sessions
- clearer session visibility and revocation in the UI

### Improve Privacy For Stored Artifacts

Screenshots, responsive snapshots, logs, and similar artifacts can contain sensitive page data.

Potential hardening:

- shorter retention windows
- clearer UI indicators for what is being stored
- optional automatic cleanup on workspace close
- optional redaction or metadata-only storage modes
