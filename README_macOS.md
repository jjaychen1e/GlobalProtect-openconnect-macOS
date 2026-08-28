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

sudo mkdir -p /usr/local/libexec/gpclient
sudo cp packaging/files/usr/libexec/gpclient/vpnc-script /usr/local/libexec/gpclient/vpnc-script
sudo cp packaging/files/usr/libexec/gpclient/hipreport.sh /usr/local/libexec/gpclient/hipreport.sh
sudo chmod +x /usr/local/libexec/gpclient/vpnc-script /usr/local/libexec/gpclient/hipreport.sh
```

`vpnc-script` and `hipreport.sh` go under `/usr/local/libexec/gpclient/` because that is the first path the client searches on every architecture.

## 3. URL handler

```bash
./install-macos-url-handler.sh
```

This registers `globalprotectcallback1://` and forwards the URL to `gpclient launch-gui`. Re-run the script after you move `gpclient`.

## 4. Connect

You must pass `--gateway` unless you want the client to list gateways and then fail with `Failed to initialize input reader`.

```bash
gpauth <your_portal> --browser default 2>/dev/null | sudo gpclient connect <your_portal> --cookie-on-stdin --gateway <your_gateway>
```

Split tunnel with `vpn-slice`:

```bash
gpauth <your_portal> --browser default 2>/dev/null | sudo gpclient connect <your_portal> --cookie-on-stdin --gateway <your_gateway> -s "vpn-slice xxx.xxx.xxx.xxx"
```
