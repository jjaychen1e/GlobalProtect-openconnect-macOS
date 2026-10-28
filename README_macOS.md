# macOS (CLI)

This tree tracks upstream GlobalProtect-openconnect and keeps the SSO callback scheme `globalprotectcallback1`, so it does not collide with the official Palo Alto GlobalProtect client.

Do not run `make install`. That target writes to `/usr/bin` (Linux layout).

## 1. Build

```bash
git submodule update --init --recursive

brew install rust autoconf automake libtool pkg-config libxml2 gnutls p11-kit nettle gmp lz4 gettext

export PKG_CONFIG_PATH="$(brew --prefix)/lib/pkgconfig:$(brew --prefix libxml2)/lib/pkgconfig"

cargo build --release -p gpclient -p gpauth -p gpservice
```

## 2. Install binaries

Apple Silicon Homebrew prefix is `/opt/homebrew`. Intel is `/usr/local`.

```bash
PREFIX="$(brew --prefix)"
sudo cp target/release/gpclient target/release/gpauth target/release/gpservice "$PREFIX/bin/"

mkdir -p "$PREFIX/lib/gpclient"
cp "$(sh scripts/macos-openconnect-library.sh target/release/gpclient)" "$PREFIX/lib/gpclient/"

sudo mkdir -p /usr/local/libexec/gpclient
sudo cp packaging/files/usr/libexec/gpclient/vpnc-script /usr/local/libexec/gpclient/vpnc-script
sudo cp packaging/files/usr/libexec/gpclient/hipreport.sh /usr/local/libexec/gpclient/hipreport.sh
sudo chmod +x /usr/local/libexec/gpclient/vpnc-script /usr/local/libexec/gpclient/hipreport.sh
```

`gpclient` and `gpservice` load `libopenconnect.5.dylib` from `$PREFIX/lib/gpclient/`. This library is built from the `crates/openconnect/deps/openconnect` submodule; Homebrew's `openconnect` lacks functions they call. Copy it again after every rebuild. Without it, `gpclient` uses the copy in this checkout's `target/` folder, then fails with `Library not loaded: @rpath/libopenconnect.5.dylib` once that folder is cleaned or deleted.

`vpnc-script` and `hipreport.sh` go under `/usr/local/libexec/gpclient/` because that is the first path the client searches on every architecture.

## 3. URL handler

```bash
./install-macos-url-handler.sh
```

This installs `/Applications/GlobalProtectURLHandler.app` for `globalprotectcallback1:`. The app runs `gpauth auth-callback <url>`, which hands the URL to the `gpauth --browser default` that is waiting for it. Re-run the script after you move `gpauth`; rebuilding it in place needs no re-run.

The portal's success page still sends `globalprotectcallback:` (no `1`) to the official client, and the token in it expires 60 seconds after that page loads. Install the Tampermonkey script so Chrome opens `globalprotectcallback1:` instead:

1. In Chrome, click the Tampermonkey icon → **Create a new script**. Replace the template with the contents of [`userscripts/globalprotect-callback1.user.js`](userscripts/globalprotect-callback1.user.js) and press Cmd+S. On macOS, `pbcopy < userscripts/globalprotect-callback1.user.js` puts the file on the clipboard.
2. Open `chrome://extensions` → Tampermonkey → **Details** and turn on **Allow User Scripts**. Without it, Tampermonkey saves the script but Chrome does not run it.
3. On the first sign-in after that, Chrome asks whether to open GlobalProtectURLHandler. Tick **Always allow** for the portal, then click **Open**. Later sign-ins open it without asking.

The script runs only on `https://*/SAML20/SP/ACS*`. It puts a bar at the top of that page with a link to the `globalprotectcallback1:` URL and the seconds left on the token. If gpclient did not receive the callback, click that link.

## 4. Connect

You must pass `--gateway` unless you want the client to list gateways and then fail with `Failed to initialize input reader`.

```bash
gpauth <your_portal> --browser default 2>/dev/null | sudo gpclient connect <your_portal> --cookie-on-stdin --gateway <your_gateway>
```

Split tunnel with `vpn-slice`:

```bash
gpauth <your_portal> --browser default 2>/dev/null | sudo gpclient connect <your_portal> --cookie-on-stdin --gateway <your_gateway> -s "vpn-slice xxx.xxx.xxx.xxx"
```

Do not pass `--os-version`. Both binaries report the real macOS version. Upstream treats `--os-version` as deprecated and ignores it.

Without `-s`, upstream configures routes and DNS itself on macOS and does not run `vpnc-script`. With `-s`, it runs the script you give it.

## 5. Reconnect without the browser

`--cookie-cache` (upstream) stores the portal cookie so later connects skip SSO. Point it at a path in your home directory; under `sudo` the default `$HOME` is `/var/root`.

```bash
gpauth <your_portal> --browser default 2>/dev/null | sudo gpclient connect <your_portal> \
  --cookie-on-stdin --gateway <your_gateway> --cookie-cache "$HOME/.config/gpclient/cookie.json"

# later, no browser
sudo gpclient connect <your_portal> --gateway <your_gateway> --cookie-cache "$HOME/.config/gpclient/cookie.json"
```

The cache only skips SSO. It does not extend the gateway session: the gateway sets an absolute expiry at sign-in, and when the portal reports `allow_extend_session=false` nothing renews it. `gpclient` logs the value as `VPN session info: … user_expires=…` and writes it to `session.json` next to the cookie.

## 6. Menu bar app

[`raycast/gpclient`](raycast/gpclient/README.md) is a Raycast extension that drives these same commands: sign in, reconnect, disconnect, switch gateway, toggle split versus full tunnel, and watch the session expiry. Its README covers install and configuration.

## Changes versus upstream

For CAS portals:

- getconfig sends blank `portal-userauthcookie` / `portal-prelogonuserauthcookie`. Upstream sends the literal string `empty`, which such a portal rejects with HTTP 512.
- `--cookie-on-stdin` skips a second portal prelogin, because `gpauth` already did prelogin and SAML. Repeating it invalidates the CAS token.

For the SSO callback:

- The callback scheme is `globalprotectcallback1`, so it cannot collide with the official Palo Alto client, which owns `globalprotectcallback`.
- `gpauth` rewrites `globalprotectcallback:` to `globalprotectcallback1:` in the SAML HTML it serves. If the identity provider's final redirect still omits the `1`, add it in the address bar.
- The portal's success page (`https://<portal>/SAML20/SP/ACS`) is not served by `gpauth`, so it still sends `globalprotectcallback:` to the official client. Its CAS token expires 60 seconds after that page loads. Install [`userscripts/globalprotect-callback1.user.js`](userscripts/globalprotect-callback1.user.js) in Tampermonkey: it rewrites the page to `globalprotectcallback1:` before Chrome follows it, and shows a link plus the seconds left in case Chrome does not open it.

For everyday use from a menu bar:

- The cookie cache also stores the gateway list from the last portal getconfig, and a reconnect refreshes both that list and the cookie the portal reissues.
- Root writes the cookie cache, so it is chowned to the owner of its directory; otherwise a user-level tool cannot read it.
- `session.pid` and `session.json` are written next to the cookie, user-readable, so a menu bar can see a root tunnel and its expiry without `sudo`.
- `disconnect` escalates SIGINT to SIGTERM to SIGKILL and cleans up stale PID files.
- `gpauth auth-callback <url>` is built on macOS too; upstream builds it only on Linux and BSD. The URL handler from step 3 calls it.
- `gpauth` does not make "GP Connect Login.app" the default handler for the callback scheme. Upstream does that on every browser sign-in and fails when the app is missing.
- `connect --no-auth-prompt` exits with `Sign-in required …` instead of opening `gpauth`'s login window or asking for a password. Without it, a reconnect whose cached cookie is rejected, or a tunnel that drops later, opens that window on its own.

Note that a second `gpclient` process is killed immediately while a tunnel is up, so `gpclient disconnect` cannot be used to stop a running tunnel from another process; `raycast/gpclient/gp-disconnect.sh` signals the PID directly instead.
