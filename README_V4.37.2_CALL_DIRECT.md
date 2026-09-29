# Zento v4.37.2 — Direct WebRTC Calls

- TURN removed from the call path.
- Calls use STUN + direct peer-to-peer WebRTC only.
- Metered/OpenRelay integration removed.
- Call status now shows direct connection state.
- Call UI receives a polished connection indicator and responsive controls.

Important: direct WebRTC cannot guarantee connectivity on every restrictive NAT/firewall because no relay server is used.
