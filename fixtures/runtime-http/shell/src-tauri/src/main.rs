fn sync(base: &str, id: u32) {
    let _ = reqwest::blocking::get(format!("{}/reports/{}", base, id));
}
