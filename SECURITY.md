# Security Policy

## Supported versions

Piner is pre-1.0. Security fixes are applied to the latest published `0.1.x`
release only.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Instead, use GitHub's private vulnerability reporting:

1. Go to the **Security** tab of the [repository](https://github.com/heyphat/piner/security).
2. Click **Report a vulnerability**.

We aim to acknowledge reports within a few days and will keep you updated on the
fix and disclosure timeline.

## Scope

Piner compiles and executes Pine Script source. Of particular interest:

- Ways untrusted Pine source can escape the sandbox or reach host globals
  (the runtime rejects reserved-property access and enforces a per-bar
  loop-iteration budget — bypasses of either are in scope).
- Resource-exhaustion / denial-of-service via crafted scripts.
- Prototype pollution or arbitrary code execution through the compiler pipeline.

Thanks for helping keep Piner and its users safe.
