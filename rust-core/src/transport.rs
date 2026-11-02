use std::{net::IpAddr, time::Duration};

use reqwest::{redirect::Policy, Url};

use crate::model::Candidate;

const MAX_CANDIDATE_BYTES: usize = 64 * 1024;

#[derive(Debug)]
pub struct CandidateSender {
    endpoint: Url,
    client: reqwest::Client,
}

impl CandidateSender {
    pub fn new(endpoint: impl AsRef<str>, timeout: Duration) -> Result<Self, String> {
        if timeout.is_zero() {
            return Err("candidate timeout must be positive".into());
        }
        let endpoint = Url::parse(endpoint.as_ref()).map_err(|error| error.to_string())?;
        let loopback = endpoint
            .host_str()
            .map(|host| host.trim_start_matches('[').trim_end_matches(']'))
            .and_then(|host| host.parse::<IpAddr>().ok())
            .is_some_and(|address| address.is_loopback());
        if !matches!(endpoint.scheme(), "http" | "https")
            || !loopback
            || !endpoint.username().is_empty()
            || endpoint.password().is_some()
            || endpoint.query().is_some()
            || endpoint.fragment().is_some()
        {
            return Err("candidate endpoint must be literal loopback HTTP without credentials, query, or fragment".into());
        }
        let client = reqwest::Client::builder()
            .timeout(timeout)
            .redirect(Policy::none())
            .build()
            .map_err(|error| error.to_string())?;
        Ok(Self { endpoint, client })
    }

    pub fn validate_payload(&self, candidate: &Candidate) -> Result<(), &'static str> {
        candidate.validate()
    }

    pub async fn send(&self, candidate: Candidate) -> Result<(), String> {
        self.validate_payload(&candidate).map_err(str::to_owned)?;
        let payload = serde_json::to_vec(&candidate).map_err(|error| error.to_string())?;
        if payload.len() > MAX_CANDIDATE_BYTES {
            return Err("candidate payload exceeds 64 KiB".into());
        }
        let response = self
            .client
            .post(self.endpoint.clone())
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(payload)
            .send()
            .await
            .map_err(|error| error.to_string())?;
        if response.status().is_success() {
            Ok(())
        } else {
            Err(format!("candidate endpoint returned {}", response.status()))
        }
    }
}
