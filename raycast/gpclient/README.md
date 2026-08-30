# Raycast menu bar for gpclient

Reconnect, disconnect, and switch gateways from the macOS menu bar.

This extension is not in the Raycast Store, so it installs from this folder. Raycast cannot install an extension from a git URL.

## Install

1. Build and install the CLI first — see [`../../README_macOS.md`](../../README_macOS.md). The menu bar only drives `gpclient` and `gpauth`.
2. `./install-macos-url-handler.sh` from the repository root, so `globalprotectcallback1://` is registered.
3. `cd raycast/gpclient && npm install && npx ray develop`. Raycast picks the extension up while this runs; press `Ctrl+C` once the commands show in Raycast search. Re-run it after adding or renaming a command in `package.json` — `ray build` alone leaves Raycast on the old command list and `launchCommand` then fails with `Command not found`.
4. `bash install-sudoers.sh`. This installs `gp-disconnect` and a `/etc/sudoers.d/gpclient` drop-in so connecting and disconnecting do not ask for a macOS password.
5. Run **VPN Menu Bar** once so the lock icon stays in the menu bar.

## Configure

Raycast Settings → Extensions → **GlobalProtect VPN**:

| Preference | Value |
| --- | --- |
| Portal | Portal hostname |
| Default gateway | Gateway used by Reconnect. The rest are learned from the portal on the first successful connect. |
| Other gateways | Only for hosts the portal does not advertise |
| Cookie cache path | Empty means `~/.config/gpclient/cookie.json` |

Split tunnel hosts are not a preference; see [Tunnel mode](#tunnel-mode-and-split-tunnel) below.

Then use **Sign in with SSO** in the menu once, so a cookie exists.

## Signing in

Use **Sign in with SSO** in the menu. The browser opens immediately; Raycast does not wait. After SSO, macOS may ask for an admin password once to start the tunnel. Do not add `--os-version`.

This is not only a first-time step. The gateway sets an absolute session expiry (`user_expires`) at sign-in and, when the portal sets `allow_extend_session=false`, nothing renews it — reconnecting reuses the same session. The menu shows `Session ends in …`; when it runs out, sign in again.

## Progress

Reconnect, Disconnect, and Switch Gateway open **VPN Live Progress**, which re-reads `~/Library/Logs/gpclient-raycast-progress.json` several times a second. A `MenuBarExtra` dropdown cannot update while it is open — Raycast loads the command on click and unloads it on close — so the menu only carries a one-line summary and the icon.

`assets/scripts/progress.py watch` keeps that file moving after Raycast unloads the command, which is why the steps still finish if you close the window.

## Tunnel mode and split tunnel

**Tunnel Mode** switches between the `vpn-slice` split tunnel and a full tunnel. It only changes whether `-s` is passed to gpclient, so it reconnects with the cached cookie and needs no new SSO.

**Configure Split Tunnel** edits that `-s` argument as four lists, stored in `split-tunnel.json` under the extension's support directory. There is no matching preference: Raycast preferences only support single values (`textfield`, `checkbox`, `dropdown`, …) and an extension cannot write preference values back, so an add/remove list has to be its own command.

Three of the lists map onto different vpn-slice behaviour, and mixing them up is what makes these lists grow forever:

| List | Flag | Effect |
| --- | --- | --- |
| VPN DNS domains | `--domains-vpn-dns` | Writes `/etc/resolver/<domain>` with the DNS servers this connection was handed, and removes it on disconnect. Resolution only — no route. |
| Routed subnets | positional CIDR | One route covering a whole range. |
| Hosts | positional name | Resolved once at connect time into `/etc/hosts` plus a `/32` route each. |
| Search domain | `-d` | Lets short names resolve. |

A host only needs its own entry when its address falls outside every routed subnet. Anything that resolves inside a listed subnet is covered by the DNS domain plus that subnet, so it never has to be listed.

## Errors

Failed actions copy the message to the clipboard (when Raycast is still in the foreground) and write `~/Library/Logs/gpclient-raycast-last.txt`. The SSO helper also shows a macOS notification. Use **Copy last error** in the menu if the HUD already disappeared.

## Logs

Menu bar → **Logs** opens one of these files in Console.app, which tails it live. Each entry shows how old the file is, so you can tell which run is the current one.

- `~/Library/Logs/gpclient-raycast-reconnect.log`
- `~/Library/Logs/gpclient-raycast-first-login.log`
- `~/Library/Logs/gpclient-raycast-progress.log`
- `~/Library/Logs/gpclient-raycast.log`

**Copy last 50 lines** in the same submenu puts the tail of all files on the clipboard.

A Raycast list view was tried first for tailing and dropped: re-rendering the tail every second hit the 100 MB extension heap limit. Console does live tailing for free.

## Distribution

`ray publish` targets the Raycast Store, which means a pull request to [raycast/extensions](https://github.com/raycast/extensions) and a review, or a Raycast Teams private store. Neither fits an extension that shells out to `sudo gpclient`, so treat this folder as the distribution: clone the repository and follow Install above.
