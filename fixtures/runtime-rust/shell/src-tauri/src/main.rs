use std::process::Command;

const HELPER: &str = "helper";

fn main() {
    let _ = Command::new(HELPER).arg("--serve").spawn();
    let _ = Command::new("ls").status();
}
