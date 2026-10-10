//! AES-256-GCM secret storage compatible with Node `enc:v1:iv:tag:ciphertext`.

use aes_gcm::{
    Aes256Gcm, Nonce,
    aead::{Aead, KeyInit},
};
use anyhow::{Context, Result, bail};
use base64::{Engine, engine::general_purpose::STANDARD as B64};
use rand::RngCore;
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
};

const ENC_PREFIX: &str = "enc:v1:";

fn secret_path(root: &Path) -> PathBuf {
    root.join("data").join(".molan-secret")
}

fn material_from_env_or_file(root: &Path) -> Result<[u8; 32]> {
    if let Ok(env) = std::env::var("MOLAN_SECRET")
        .or_else(|_| std::env::var("MOLAN_ENCRYPTION_KEY"))
    {
        let env = env.trim();
        if !env.is_empty() {
            let dig = Sha256::digest(env.as_bytes());
            let mut out = [0u8; 32];
            out.copy_from_slice(&dig);
            return Ok(out);
        }
    }
    let path = secret_path(root);
    if path.exists() {
        let raw = fs::read_to_string(&path)?.trim().to_string();
        if raw.len() >= 32 {
            let dig = Sha256::digest(raw.as_bytes());
            let mut out = [0u8; 32];
            out.copy_from_slice(&dig);
            return Ok(out);
        }
    }
    let mut generated = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut generated);
    let hex = hex::encode(generated);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&path, &hex).with_context(|| format!("无法持久化密钥材料到 {}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    let dig = Sha256::digest(hex.as_bytes());
    let mut out = [0u8; 32];
    out.copy_from_slice(&dig);
    Ok(out)
}

pub fn encrypt_secret(root: &Path, plain: &str) -> Result<String> {
    if plain.is_empty() {
        return Ok(String::new());
    }
    if plain.starts_with(ENC_PREFIX) {
        return Ok(plain.to_string());
    }
    let key = material_from_env_or_file(root)?;
    let cipher = Aes256Gcm::new_from_slice(&key).context("AES key")?;
    let mut iv = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut iv);
    let nonce = Nonce::from_slice(&iv);
    let ciphertext = cipher
        .encrypt(nonce, plain.as_bytes())
        .map_err(|e| anyhow::anyhow!("encrypt failed: {e}"))?;
    // aes-gcm crate appends tag to ciphertext
    if ciphertext.len() < 16 {
        bail!("ciphertext too short");
    }
    let (data, tag) = ciphertext.split_at(ciphertext.len() - 16);
    Ok(format!(
        "{ENC_PREFIX}{}:{}:{}",
        B64.encode(iv),
        B64.encode(tag),
        B64.encode(data)
    ))
}

pub fn decrypt_secret(root: &Path, stored: &str) -> Result<String> {
    if stored.is_empty() {
        return Ok(String::new());
    }
    if !stored.starts_with(ENC_PREFIX) {
        return Ok(stored.to_string());
    }
    let rest = &stored[ENC_PREFIX.len()..];
    let parts: Vec<&str> = rest.split(':').collect();
    if parts.len() != 3 {
        bail!("密钥密文损坏");
    }
    let iv = B64.decode(parts[0]).context("iv")?;
    let tag = B64.decode(parts[1]).context("tag")?;
    let data = B64.decode(parts[2]).context("data")?;
    let key = material_from_env_or_file(root)?;
    let cipher = Aes256Gcm::new_from_slice(&key).context("AES key")?;
    let mut combined = data;
    combined.extend_from_slice(&tag);
    let nonce = Nonce::from_slice(&iv);
    let plain = cipher
        .decrypt(nonce, combined.as_ref())
        .map_err(|_| anyhow::anyhow!("密钥密文损坏"))?;
    Ok(String::from_utf8(plain).context("utf8")?)
}

pub fn key_hint(secret: &str) -> Option<String> {
    if secret.len() < 4 {
        return None;
    }
    let tail = &secret[secret.len() - 4..];
    if secret.starts_with("sk-") {
        Some(format!("sk-…{tail}"))
    } else {
        Some(format!("…{tail}"))
    }
}

pub fn env_api_key() -> String {
    std::env::var("MOLAN_API_KEY")
        .or_else(|_| std::env::var("OPENAI_API_KEY"))
        .unwrap_or_default()
        .trim()
        .to_string()
}
