use std::{io::Cursor, net::SocketAddr};

use common::constants::GP_CALLBACK_SCHEME;
use log::info;
use tiny_http::{Header, Method, Response, Server};
use uuid::Uuid;

const OFFICIAL_CALLBACK_SCHEME: &str = "globalprotectcallback:";

pub(super) struct AuthServer {
  server: Server,
  auth_id: String,
}

impl AuthServer {
  pub fn new(addr: SocketAddr) -> anyhow::Result<Self> {
    let server = Server::http(addr).map_err(|err| anyhow::anyhow!(err))?;
    let auth_id = Uuid::new_v4().to_string();

    let auth_server = Self { server, auth_id };
    info!("auth server started at: {}", auth_server.auth_url());
    Ok(auth_server)
  }

  pub fn auth_url(&self) -> String {
    format!("http://{}/{}", self.server.server_addr(), self.auth_id)
  }

  pub fn serve_request(&self, auth_request: &str) {
    for req in self.server.incoming_requests() {
      info!("received request, method: {}, url: {}", req.method(), req.url());

      if req.url() != format!("/{}", self.auth_id) {
        let forbidden = Response::from_string("forbidden").with_status_code(403);
        let _ = req.respond(forbidden);
      } else if req.method() == &Method::Head {
        if let Err(err) = req.respond(Response::empty(200)) {
          info!("failed to respond to HEAD request: {}", err);
        }
      } else {
        let auth_response = build_auth_response(auth_request);
        if let Err(err) = req.respond(auth_response) {
          info!("failed to respond to request: {}", err);
        } else {
          info!("stop the auth server");
          break;
        }
      }
    }
  }
}

fn build_auth_response(auth_request: &str) -> Response<Cursor<Vec<u8>>> {
  let auth_request = rewrite_official_callback_scheme(auth_request);
  if auth_request.starts_with("http") {
    let header = format!("location: {}", auth_request);
    let header: Header = header.parse().unwrap();
    Response::from_string("redirect")
      .with_status_code(302)
      .with_header(header)
  } else {
    let content_type: Header = "content-type: text/html".parse().unwrap();
    Response::from_string(auth_request).with_header(content_type)
  }
}

/// Map the official GlobalProtect callback scheme to this fork's scheme.
/// NVIDIA SSO HTML still emits `globalprotectcallback:`; the macOS handler is `globalprotectcallback1`.
fn rewrite_official_callback_scheme(input: &str) -> String {
  let ours = format!("{}:", GP_CALLBACK_SCHEME);
  if OFFICIAL_CALLBACK_SCHEME == ours {
    return input.to_string();
  }
  const PLACEHOLDER: &str = "\u{E000}gp-callback-scheme\u{E000}";
  input
    .replace(&ours, PLACEHOLDER)
    .replace(OFFICIAL_CALLBACK_SCHEME, &ours)
    .replace(PLACEHOLDER, &ours)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn rewrites_official_scheme_and_keeps_callback1() {
    let html = r#"href="globalprotectcallback:cas-as=1" and already globalprotectcallback1:keep""#;
    let rewritten = rewrite_official_callback_scheme(html);
    assert!(rewritten.contains("globalprotectcallback1:cas-as=1"));
    assert!(rewritten.contains("globalprotectcallback1:keep"));
    assert!(!rewritten.contains("globalprotectcallback11:"));
    assert!(!rewritten.contains("globalprotectcallback:cas"));
  }
}
