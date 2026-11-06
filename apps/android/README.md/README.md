# KICK'S — Android app
Expo SDK 57 / React Native 0.86.2 / React 19.2.3 / Expo Router / TypeScript. Native layer: Kotlin VpnService DNS collector (TUN 10.111.222.2/32, port 53 only), Keystore secure storage, foreground notification "KICK'S privacy monitoring". Tabs: Activity · Engine (exfiltration feed) · Permissions · Opportunities · Wallet · Settings. Consent flow: Ask / Modify / Receipt. Reduced version target: Tuesday, November 24, 2026. Android-first for DNS monitoring.

The floating ASK control currently opens a shared **example-only** consent preview.
It does not create consent, share data, or create a wallet receipt. Real grant and
revocation controls remain unavailable until secure device enrollment and
server-enforced study scope and expiry are implemented.
