// A failed request cannot distinguish filtering from an outage. Keep this a
// possible cause, and suggest a way to check without changing server settings.
export const NETWORK_BLOCKING_HINT =
  "Your DNS or firewall may be blocking T3 Connect. Try another network, such as a phone hotspot.";

// Used once the ticket and descriptor requests succeeded, so only the socket
// failed. iOS Wi-Fi Assist can move HTTP to cellular while the socket stays on
// Wi-Fi, so suggesting another network would point at the wrong path.
export const WEBSOCKET_BLOCKING_HINT =
  "Wi-Fi Assist (Connectivity Assist on iOS), a VPN, or a content filter may be blocking the WebSocket.";
