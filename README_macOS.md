Here is how you can run this tool in CLI mode, in macOS. Make sure you have installed openconnect, etc.

1. Update `crates/gpapi/src/lib.rs`

Replace `/usr/bin/` with `/usr/local/bin/`:

```
#[cfg(not(debug_assertions))]
pub const GP_CLIENT_BINARY: &str = "/usr/local/bin/gpclient";
#[cfg(not(debug_assertions))]
pub const GP_SERVICE_BINARY: &str = "/usr/local/bin/gpservice";
#[cfg(not(debug_assertions))]
pub const GP_GUI_BINARY: &str = "/usr/local/bin/gpgui";
#[cfg(not(debug_assertions))]
pub const GP_GUI_HELPER_BINARY: &str = "/usr/local/bin/gpgui-helper";
#[cfg(not(debug_assertions))]
pub(crate) const GP_AUTH_BINARY: &str = "/usr/local/bin/gpauth";
```

2. Execute `./install-macos-url-handler.sh`

This is a script that will install the URL handler for the `globalprotectcallback` URL scheme.

The script is written by AI, run with caution.

3. Build: `cargo build -p gpclient -p gpapi`

4. Copy build binaries to `/usr/local/bin/`:

```
sudo cp ./target/release/gpclient /usr/local/bin/
sudo cp ./target/release/gpauth /usr/local/bin/
```

5. Connect:

You must specify the gateway in the command unless you will get `Error: IO error: Failed to initialize input reader`. If you don't know the url of gateway, just omit the option and you will get a list of gateways before it throws the error.

```
gpauth <your_portal> --browser default 2>/dev/null | sudo gpclient connect <your_portal> --cookie-on-stdin --gateway <your_gateway>"
```

If you want to split the tunnel, you can add `vpn-slice` in the `-s` option (refer the doc of vpn-slice for how to install it).

```
gpauth <your_portal> --browser default 2>/dev/null | sudo gpclient connect <your_portal> --cookie-on-stdin --gateway <your_gateway> -s "vpn-slice xxx.xxx.xxx.xxx"
```
