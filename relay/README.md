# Phone Farm Relay

The relay is the server-side control plane. It does not run iOS automation and
never connects to an iPhone itself. It only keeps the queue between the web
console and each Mac gateway:

1. the operator manually confirms a task;
2. the relay encrypts transport with the existing HTTPS reverse proxy and
   leases the task to one enrolled Mac gateway;
3. the gateway reports `submitted` or `manual_review` once it has acted;
4. the relay records a content hash, not message text, in task summaries.

Run it only with a long random console token. The public web console must not
embed that token; a later bridge setup stores it in the operator's local keychain.
