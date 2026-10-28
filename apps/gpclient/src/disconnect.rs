use clap::Args;
use gpapi::process::users::get_non_root_user;
use gpapi::utils::lock_file::gpservice_lock_info;
use log::{info, warn};
use std::{
  fs,
  path::Path,
  process::{Command, Stdio},
  str::FromStr,
  thread,
  time::Duration,
};
use sysinfo::{Pid, Signal, System};

#[derive(Args)]
pub struct DisconnectArgs {
  #[arg(
    long,
    required = false,
    help = "The time in seconds to wait for the VPN connection to disconnect"
  )]
  wait: Option<u64>,
}

pub struct DisconnectHandler<'a> {
  args: &'a DisconnectArgs,
  lock_file: &'a Path,
}

impl<'a> DisconnectHandler<'a> {
  pub fn new(args: &'a DisconnectArgs, lock_file: &'a Path) -> Self {
    Self { args, lock_file }
  }

  pub async fn handle(&self) -> anyhow::Result<()> {
    let wait_secs = self.args.wait.unwrap_or(5);
    let self_pid = std::process::id().to_string();
    let mut pids = Vec::new();

    if let Ok(pid) = fs::read_to_string(self.lock_file) {
      pids.push(pid.trim().to_string());
    }
    if let Ok(output) = Command::new("pgrep").args(["-x", "gpclient"]).output() {
      for pid in String::from_utf8_lossy(&output.stdout).lines() {
        let pid = pid.trim();
        if !pid.is_empty() {
          pids.push(pid.to_string());
        }
      }
    }

    let mut seen = std::collections::HashSet::new();
    let mut cli_signalled = false;
    for pid in pids {
      if pid == self_pid || !seen.insert(pid.clone()) {
        continue;
      }
      cli_signalled |= stop_cli_client(&pid, wait_secs, self.lock_file)?;
    }

    if let Ok(path) = user_session_pid_path() {
      let _ = fs::remove_file(path);
    }

    // Try to disconnect the GUI service
    if !cli_signalled && let Ok(c) = gpservice_lock_info().await {
      send_signal(&c.pid.to_string(), Signal::User1).unwrap_or_else(|err| {
        warn!("Failed to send signal to service: {}", err);
        false
      });
    }

    Ok(())
  }
}

/// `~/.config/gpclient/session.pid` for the sudo-invoking user.
fn user_session_pid_path() -> anyhow::Result<std::path::PathBuf> {
  let user = get_non_root_user()?;
  Ok(std::path::PathBuf::from(format!(
    "/Users/{}/.config/gpclient/session.pid",
    user.name().to_string_lossy()
  )))
}

/// Ask a CLI `gpclient connect` to exit. SIGINT is ignored when the process
/// was started from osascript (no TTY), so escalate to SIGTERM then SIGKILL.
/// Returns false when `pid` was already gone, true when it was signalled.
fn stop_cli_client(pid: &str, wait_secs: u64, lock_file: &Path) -> anyhow::Result<bool> {
  if pid == std::process::id().to_string() {
    anyhow::bail!("refusing to signal this disconnect process; stale lock file?");
  }

  if !process_alive(pid) {
    let _ = fs::remove_file(lock_file);
    return Ok(false);
  }

  info!("Signaling gpclient PID {pid} with SIGINT");
  send_unix_signal(pid, "INT")?;
  if wait_until_gone(pid, Duration::from_secs(2)) {
    return Ok(true);
  }

  info!("PID {pid} ignored SIGINT, sending SIGTERM");
  send_unix_signal(pid, "TERM")?;
  if wait_until_gone(pid, Duration::from_secs(wait_secs.max(1))) {
    return Ok(true);
  }

  warn!("PID {pid} still alive, sending SIGKILL");
  send_unix_signal(pid, "KILL")?;
  if wait_until_gone(pid, Duration::from_secs(2)) {
    let _ = fs::remove_file(lock_file);
    return Ok(true);
  }

  anyhow::bail!("gpclient PID {pid} is still running after SIGKILL");
}

/// True when `/bin/kill -0` succeeds, i.e. the PID exists and is reachable.
fn process_alive(pid: &str) -> bool {
  Command::new("/bin/kill")
    .args(["-0", pid])
    .stderr(Stdio::null())
    .status()
    .map(|status| status.success())
    .unwrap_or(false)
}

/// Send a POSIX signal with `/bin/kill -s`. Do not use PATH `kill` or `-TERM`
/// form; Homebrew/PATH wrappers have killed the disconnect process instead.
fn send_unix_signal(pid: &str, sig_name: &str) -> anyhow::Result<()> {
  let status = Command::new("/bin/kill").args(["-s", sig_name, pid]).status()?;
  if !status.success() && process_alive(pid) {
    anyhow::bail!("kill -s {sig_name} {pid} failed with {status}");
  }
  Ok(())
}

/// Poll until the PID is gone or `timeout` elapses.
fn wait_until_gone(pid: &str, timeout: Duration) -> bool {
  let start = std::time::Instant::now();
  while start.elapsed() < timeout {
    if !process_alive(pid) {
      return true;
    }
    thread::sleep(Duration::from_millis(200));
  }
  !process_alive(pid)
}

fn send_signal(pid: &str, signal: Signal) -> anyhow::Result<bool> {
  let s = System::new_all();
  let pid = Pid::from_str(pid)?;

  if let Some(process) = s.process(pid) {
    info!("Found process {}, sending signal...", pid);

    return Ok(process.kill_with(signal).unwrap_or(false));
  }
  Ok(false)
}
