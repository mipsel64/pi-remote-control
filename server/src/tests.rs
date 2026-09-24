use super::*;
use futures_util::{SinkExt, StreamExt};
use reqwest::Client;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, Message as WsMessage},
};

async fn fixture() -> (String, tokio::task::JoinHandle<()>) {
    fixture_with_push(false, "http://127.0.0.1:8787").await
}
async fn fixture_with_push(enabled: bool, origin: &str) -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let state = tempfile::tempdir().unwrap();
    let s = Settings {
        host: "127.0.0.1".into(),
        port,
        origin: origin.into(),
        token: "agent-test".into(),
        password: "admin-test".into(),
        push: enabled.then(|| Push {
            public: "public-key".into(),
            private: "unused-in-api-test".into(),
            subject: "mailto:test@example.com".into(),
            client: IsahcWebPushClient::new().unwrap(),
        }),
        state_dir: state.path().join("prc"),
    };
    let url = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        let _state = state;
        axum::serve(listener, router(s)).await.unwrap()
    });
    (url, task)
}
async fn next<
    S: StreamExt<Item = Result<WsMessage, tokio_tungstenite::tungstenite::Error>> + Unpin,
>(
    socket: &mut S,
) -> Value {
    serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap()
}
#[tokio::test]
async fn auth_relay_reconnect_and_embedded_assets() {
    let (url, task) = fixture().await;
    let client = Client::new();
    let root = client.get(&url).send().await.unwrap();
    assert_eq!(root.status(), 200);
    assert!(root.text().await.unwrap().contains("/assets/index-"));
    let worker = client.get(format!("{url}/sw.js")).send().await.unwrap();
    assert_eq!(worker.status(), 200);
    let worker = worker.text().await.unwrap();
    assert!(worker.contains("const PRECACHE = [\"/assets/") && worker.contains("\"/assets/index-"));
    assert_eq!(
        client
            .get(format!("{url}/%2e%2e/DESIGN.md"))
            .send()
            .await
            .unwrap()
            .status(),
        404
    );
    assert_eq!(
        client
            .get(format!("{url}/api/push-key"))
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    assert_eq!(
        client
            .post(format!("{url}/api/login"))
            .header("Origin", "https://evil.invalid")
            .json(&json!({"password":"admin-test"}))
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    assert_eq!(
        client
            .post(format!("{url}/api/login"))
            .header("Origin", "http://127.0.0.1:8787")
            .json(&json!({"password":"bad"}))
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    let login = client
        .post(format!("{url}/api/login"))
        .header("Origin", "http://127.0.0.1:8787")
        .json(&json!({"password":"admin-test"}))
        .send()
        .await
        .unwrap();
    let cookie = login
        .headers()
        .get("set-cookie")
        .unwrap()
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_string();
    let ws_url = url.replace("http", "ws");
    assert!(connect_async(format!("{ws_url}/agent")).await.is_err());
    let mut req = format!("{ws_url}/agent").into_client_request().unwrap();
    req.headers_mut()
        .insert("Authorization", "Bearer agent-test".parse().unwrap());
    let (mut agent, _) = connect_async(req).await.unwrap();
    let mut req = format!("{ws_url}/ui").into_client_request().unwrap();
    req.headers_mut()
        .insert("Origin", "http://127.0.0.1:8787".parse().unwrap());
    req.headers_mut().insert("Cookie", cookie.parse().unwrap());
    let (mut browser, _) = connect_async(req.clone()).await.unwrap();
    assert_eq!(next(&mut browser).await["type"], "sessions");
    agent.send(WsMessage::Text(json!({"type":"hello","processId":"p","sessionId":"s","name":"Pi","cwd":"/tmp","busy":false,"updatedAt":1234}).to_string().into())).await.unwrap();
    assert_eq!(next(&mut agent).await["type"], "history");
    let initial = next(&mut browser).await;
    assert_eq!(initial["sessions"][0]["updatedAt"], 1234);
    let first = initial["sessions"][0]["connectionId"].clone();
    browser
        .send(WsMessage::Text(
            json!({"type":"select","processId":"p"}).to_string().into(),
        ))
        .await
        .unwrap();
    assert_eq!(next(&mut agent).await["type"], "history");
    browser
        .send(WsMessage::Text(
            json!({"type":"prompt","processId":"p","sessionId":"s","text":"hello"})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    assert_eq!(
        next(&mut agent).await,
        json!({"type":"prompt","sessionId":"s","text":"hello"})
    );
    let mut replacement = format!("{ws_url}/agent").into_client_request().unwrap();
    replacement
        .headers_mut()
        .insert("Authorization", "Bearer agent-test".parse().unwrap());
    let (mut agent2, _) = connect_async(replacement).await.unwrap();
    agent2.send(WsMessage::Text(json!({"type":"hello","processId":"p","sessionId":"s2","name":"Pi","cwd":"/tmp","busy":false}).to_string().into())).await.unwrap();
    assert_eq!(next(&mut agent2).await["sessionId"], "s2");
    let changed = next(&mut browser).await;
    assert_ne!(changed["sessions"][0]["connectionId"], first);
    browser
        .send(WsMessage::Text(
            json!({"type":"abort","processId":"p","sessionId":"s"})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    assert_eq!(
        next(&mut browser).await["message"],
        "Invalid or stale command"
    );
    agent2
        .send(WsMessage::Text(
            json!({"type":"snapshot","processId":"p","sessionId":"s2","entries":[{"text":"past"}]})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    assert_eq!(next(&mut browser).await["entries"][0]["text"], "past");
    let mut second_request = format!("{ws_url}/agent").into_client_request().unwrap();
    second_request
        .headers_mut()
        .insert("Authorization", "Bearer agent-test".parse().unwrap());
    let (mut second_agent, _) = connect_async(second_request).await.unwrap();
    second_agent.send(WsMessage::Text(json!({"type":"hello","processId":"p2","sessionId":"other","name":"Other","cwd":"/tmp","busy":false}).to_string().into())).await.unwrap();
    assert_eq!(next(&mut second_agent).await["type"], "history");
    let sessions = next(&mut browser).await["sessions"]
        .as_array()
        .unwrap()
        .clone();
    assert_eq!(sessions.len(), 2);
    assert_eq!(
        sessions
            .iter()
            .find(|session| session["processId"] == "p")
            .unwrap()["updatedAt"],
        0
    );
    assert!(sessions.iter().any(|session| session["processId"] == "p"));
    assert!(sessions.iter().any(|session| session["processId"] == "p2"));
    browser
        .send(WsMessage::Text(
            json!({"type":"prompt","processId":"p2","sessionId":"other","text":"separate"})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    assert_eq!(
        next(&mut second_agent).await,
        json!({"type":"prompt","sessionId":"other","text":"separate"})
    );
    second_agent.send(WsMessage::Text(json!({"type":"event","processId":"p2","sessionId":"other","event":{"type":"queue_update","queued":["separate"]}}).to_string().into())).await.unwrap();
    let queued = |frame: Value| {
        frame["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|session| session["processId"] == "p2")
            .unwrap()["queued"]
            .clone()
    };
    assert_eq!(queued(next(&mut browser).await), json!(["separate"]));
    assert_eq!(next(&mut browser).await["event"]["type"], "queue_update");
    second_agent.close(None).await.unwrap();
    assert_eq!(queued(next(&mut browser).await), json!([]));
    task.abort();
}
#[tokio::test]
async fn canonical_and_loopback_origins_stay_exact() {
    let (url, task) = fixture_with_push(false, "https://pi.tail.example").await;
    let client = Client::new();
    let port = Url::parse(&url).unwrap().port().unwrap();
    let local = format!("http://127.0.0.1:{port}");
    let localhost = format!("http://localhost:{port}");
    let mut local_cookie = String::new();
    for origin in [
        local.as_str(),
        localhost.as_str(),
        "https://pi.tail.example",
    ] {
        let response = client
            .post(format!("{url}/api/login"))
            .header("Origin", origin)
            .json(&json!({"password":"admin-test"}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200, "{origin}");
        let cookie = response
            .headers()
            .get("set-cookie")
            .unwrap()
            .to_str()
            .unwrap();
        if origin == local.as_str() {
            local_cookie = cookie.split(';').next().unwrap().to_string();
        }
        assert_eq!(cookie.contains("; Secure"), origin.starts_with("https:"));
        let mut request = format!("{}/ui", url.replace("http", "ws"))
            .into_client_request()
            .unwrap();
        request
            .headers_mut()
            .insert("Origin", origin.parse().unwrap());
        request
            .headers_mut()
            .insert("Cookie", cookie.split(';').next().unwrap().parse().unwrap());
        let (mut browser, _) = connect_async(request).await.unwrap();
        assert_eq!(next(&mut browser).await["type"], "sessions");
    }
    for origin in [
        "https://other.tail.example",
        "http://evil.example",
        "http://localhost:9",
    ] {
        assert_eq!(
            client
                .post(format!("{url}/api/login"))
                .header("Origin", origin)
                .json(&json!({"password":"admin-test"}))
                .send()
                .await
                .unwrap()
                .status(),
            403
        );
        let mut request = format!("{}/ui", url.replace("http", "ws"))
            .into_client_request()
            .unwrap();
        request
            .headers_mut()
            .insert("Origin", origin.parse().unwrap());
        request
            .headers_mut()
            .insert("Cookie", local_cookie.parse().unwrap());
        assert!(connect_async(request).await.is_err());
    }
    task.abort();
}

#[test]
fn loopback_exceptions_do_not_apply_to_public_bind() {
    let mut settings = Settings {
        host: "0.0.0.0".into(),
        port: 8787,
        origin: "https://pi.tail.example".into(),
        token: String::new(),
        password: String::new(),
        push: None,
        state_dir: PathBuf::new(),
    };
    let mut headers = HeaderMap::new();
    headers.insert(header::ORIGIN, "http://127.0.0.1:8787".parse().unwrap());
    assert!(!same_origin(&headers, &settings));
    headers.insert(header::ORIGIN, "https://pi.tail.example".parse().unwrap());
    assert!(same_origin(&headers, &settings));
    settings.host = "127.0.0.1".into();
    settings.port = 80;
    headers.insert(header::ORIGIN, "http://localhost".parse().unwrap());
    assert!(same_origin(&headers, &settings));
    headers.insert(header::ORIGIN, "http://localhost:80".parse().unwrap());
    assert!(!same_origin(&headers, &settings));
}

#[test]
fn raw_utf16_half_chunk_and_limits() {
    let state = tempfile::tempdir().unwrap();
    let app = App::new(state_settings(state.path()));
    let id = Uuid::new_v4();
    let bid = Uuid::new_v4();
    let (tx, _rx) = mpsc::unbounded_channel();
    let (btx, mut brx) = mpsc::unbounded_channel();
    app.inner
        .lock()
        .unwrap()
        .browsers
        .insert(bid, (String::new(), btx));
    let mut process = None;
    assert!(agent_message(
        &app,
        id,
        &tx,
        &mut process,
        &json!({"type":"hello","processId":"p","sessionId":"s","name":"Pi","cwd":"/tmp","busy":false})
    ));
    assert!(raw_chunk(
        &app,
        id,
        Some("p"),
        r#"{"type":"snapshot_chunk","processId":"p","sessionId":"s","snapshotId":"a","index":0,"total":2,"data":"\ud83d"}"#
    ));
    // first browser packet is sessions; second is raw chunk, preserving literal escape.
    brx.try_recv().unwrap();
    assert!(brx
        .try_recv()
        .unwrap()
        .to_text()
        .unwrap()
        .contains(r#""data":"\ud83d""#));
    assert!(!raw_chunk(
        &app,
        id,
        Some("p"),
        r#"{"type":"snapshot_chunk","processId":"p","sessionId":"s","snapshotId":"a","index":2,"total":2,"data":"x"}"#
    ));
    assert!(valid_id(&json!("")).is_none());
    assert_eq!(app.inner.lock().unwrap().sessions["p"].updated_at, 0);
    assert!(agent_message(
        &app,
        id,
        &tx,
        &mut process,
        &json!({"type":"event","processId":"p","sessionId":"s","event":{"type":"message_end","message":{"role":"assistant","timestamp":2000000000000_u64}}})
    ));
    assert_eq!(
        app.inner.lock().unwrap().sessions["p"].updated_at,
        2000000000000_u64
    );
    assert_eq!(
        serde_json::from_str::<Value>(brx.try_recv().unwrap().to_text().unwrap()).unwrap()
            ["sessions"][0]["updatedAt"],
        2000000000000_u64
    );
}

#[tokio::test]
async fn push_api_enabled_and_disabled() {
    let client = Client::new();
    let (url, task) = fixture().await;
    let login = client
        .post(format!("{url}/api/login"))
        .header("Origin", "http://127.0.0.1:8787")
        .json(&json!({"password":"admin-test"}))
        .send()
        .await
        .unwrap();
    let cookie = login
        .headers()
        .get("set-cookie")
        .unwrap()
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap();
    let key: Value = client
        .get(format!("{url}/api/push-key"))
        .header("Cookie", cookie)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(key["publicKey"].is_null());
    assert_eq!(
        client
            .post(format!("{url}/api/subscribe"))
            .header("Cookie", cookie)
            .header("Origin", "http://127.0.0.1:8787")
            .json(&json!({}))
            .send()
            .await
            .unwrap()
            .status(),
        503
    );
    task.abort();
    let (url, task) = fixture_with_push(true, "http://127.0.0.1:8787").await;
    let login = client
        .post(format!("{url}/api/login"))
        .header("Origin", "http://127.0.0.1:8787")
        .json(&json!({"password":"admin-test"}))
        .send()
        .await
        .unwrap();
    let cookie = login
        .headers()
        .get("set-cookie")
        .unwrap()
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap();
    let key: Value = client
        .get(format!("{url}/api/push-key"))
        .header("Cookie", cookie)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(key["publicKey"], "public-key");
    let subscription =
        json!({"endpoint":"https://push.example/sub","keys":{"p256dh":"key","auth":"key"}});
    assert_eq!(
        client
            .post(format!("{url}/api/subscribe"))
            .header("Cookie", cookie)
            .header("Origin", "http://127.0.0.1:8787")
            .json(&json!({"subscription":subscription}))
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    assert_eq!(
        client
            .post(format!("{url}/api/unsubscribe"))
            .header("Cookie", cookie)
            .header("Origin", "http://127.0.0.1:8787")
            .json(&json!({"endpoint":"https://push.example/sub"}))
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    task.abort();
}

#[tokio::test]
async fn browser_frame_limit_closes_only_socket() {
    let (url, task) = fixture().await;
    let client = Client::new();
    let login = client
        .post(format!("{url}/api/login"))
        .header("Origin", "http://127.0.0.1:8787")
        .json(&json!({"password":"admin-test"}))
        .send()
        .await
        .unwrap();
    let cookie = login
        .headers()
        .get("set-cookie")
        .unwrap()
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap();
    let mut request = url.replace("http", "ws").to_string();
    request.push_str("/ui");
    let mut request = request.into_client_request().unwrap();
    request
        .headers_mut()
        .insert("Origin", "http://127.0.0.1:8787".parse().unwrap());
    request
        .headers_mut()
        .insert("Cookie", cookie.parse().unwrap());
    let (mut socket, _) = connect_async(request).await.unwrap();
    next(&mut socket).await;
    socket
        .send(WsMessage::Text("x".repeat(BROWSER_LIMIT + 1).into()))
        .await
        .unwrap();
    let closed = socket.next().await.unwrap().unwrap();
    assert!(
        matches!(closed, WsMessage::Close(Some(frame)) if frame.code == tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode::Size)
    );
    assert_eq!(client.get(url).send().await.unwrap().status(), 200);
    task.abort();
}

#[tokio::test]
async fn logout_revokes_cookie_and_closes_its_sockets() {
    let (url, task) = fixture().await;
    let client = Client::new();
    let origin = "http://127.0.0.1:8787";
    let login = || async {
        let res = client
            .post(format!("{url}/api/login"))
            .header("Origin", origin)
            .json(&json!({"password":"admin-test"}))
            .send()
            .await
            .unwrap();
        let set = res.headers()["set-cookie"].to_str().unwrap();
        set.split(';').next().unwrap().to_string()
    };
    let (a, b) = (login().await, login().await);
    let status = |cookie: String| {
        let req = client
            .get(format!("{url}/api/push-key"))
            .header("Cookie", cookie);
        async move { req.send().await.unwrap().status() }
    };
    let open = |cookie: &str| {
        let mut req = format!("{}/ui", url.replace("http", "ws"))
            .into_client_request()
            .unwrap();
        req.headers_mut().insert("Origin", origin.parse().unwrap());
        req.headers_mut().insert("Cookie", cookie.parse().unwrap());
        connect_async(req)
    };
    let (mut socket_a, _) = open(&a).await.unwrap();
    let (mut socket_b, _) = open(&b).await.unwrap();
    next(&mut socket_a).await;
    next(&mut socket_b).await;
    let signed_out = |msg: WsMessage| matches!(msg, WsMessage::Close(Some(frame)) if frame.reason == "Signed out");

    let logout = |path: &str, cookie: &str, origin: &str| {
        client
            .post(format!("{url}{path}"))
            .header("Cookie", cookie)
            .header("Origin", origin)
            .send()
    };
    assert_eq!(
        logout("/api/logout", &a, "https://evil.invalid")
            .await
            .unwrap()
            .status(),
        403
    );
    let res = logout("/api/logout", &a, origin).await.unwrap();
    assert_eq!(res.status(), 200);
    assert!(res.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .starts_with("rc_session=; "));
    assert!(res.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .contains("Max-Age=0"));
    assert!(signed_out(socket_a.next().await.unwrap().unwrap()));
    assert_eq!(status(a.clone()).await, 401);
    assert!(open(&a).await.is_err());
    assert_eq!(status(b).await, 200);
    socket_b
        .send(WsMessage::Text(
            json!({"type":"select","processId":"none"})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    assert_eq!(next(&mut socket_b).await["message"], "Process is offline");
    assert_eq!(
        logout("/api/logout", &a, origin).await.unwrap().status(),
        401
    );
    task.abort();
}

#[test]
fn generated_vapid_keys_are_private_reused_and_sign_payloads() {
    use openssl::{
        bn::BigNumContext,
        ec::{EcGroup, EcKey, PointConversionForm},
        nid::Nid,
    };
    let state = tempfile::tempdir().unwrap();
    let dir = state.path().join("prc");
    let file = dir.join("vapid.json");
    let push = generated_push(&dir, "mailto:admin@example.com".into()).unwrap();
    assert_eq!((mode(&dir), mode(&file)), (0o700, 0o600));
    assert_eq!(
        serde_json::from_slice::<Value>(&fs::read(&file).unwrap()).unwrap(),
        json!({"publicKey":push.public,"privateKey":push.private})
    );
    let again = generated_push(&dir, "mailto:admin@example.com".into()).unwrap();
    assert_eq!(
        (&again.public, &again.private),
        (&push.public, &push.private)
    );
    assert_eq!(URL_SAFE_NO_PAD.decode(&push.private).unwrap().len(), 32);
    assert_eq!(
        VapidSignatureBuilder::from_base64_no_sub(&push.private)
            .unwrap()
            .get_public_key(),
        URL_SAFE_NO_PAD.decode(&push.public).unwrap()
    );

    let group = EcGroup::from_curve_name(Nid::X9_62_PRIME256V1).unwrap();
    let recipient = EcKey::generate(&group).unwrap();
    let mut ctx = BigNumContext::new().unwrap();
    let public = recipient
        .public_key()
        .to_bytes(&group, PointConversionForm::UNCOMPRESSED, &mut ctx)
        .unwrap();
    let info = SubscriptionInfo::new(
        "https://push.example/sub".to_string(),
        URL_SAFE_NO_PAD.encode(public),
        URL_SAFE_NO_PAD.encode([3u8; 16]),
    );
    let mut signature = VapidSignatureBuilder::from_base64(&push.private, &info).unwrap();
    signature.add_claim("sub", push.subject);
    let mut message = WebPushMessageBuilder::new(&info);
    let payload = push_payload("Pi", "p", "s", "Finished responding");
    message.set_payload(ContentEncoding::Aes128Gcm, &payload);
    message.set_vapid_signature(signature.build().unwrap());
    assert!(message.build().is_ok());

    for invalid in [&b"{}"[..], br#"{"publicKey":"x","privateKey":"y"}"#] {
        fs::write(&file, invalid).unwrap();
        let error = generated_push(&dir, "mailto:admin@example.com".into())
            .err()
            .unwrap();
        assert!(error.contains(&file.display().to_string()), "{error}");
        assert_eq!(fs::read(&file).unwrap(), invalid);
    }
    fs::remove_file(&file).unwrap();
    std::os::unix::fs::symlink(state.path().join("elsewhere"), &file).unwrap();
    assert!(generated_push(&dir, "mailto:admin@example.com".into()).is_err());
}

#[test]
fn push_payload_names_the_finished_session() {
    let payload = |name: &str| {
        serde_json::from_slice::<Value>(&push_payload(name, "p", "s", "Done")).unwrap()
    };
    assert_eq!(
        payload("Fix the build"),
        json!({"title":"Fix the build","body":"Done","processId":"p","sessionId":"s"})
    );
    let body = |event: Value| notice_body(&event);
    assert_eq!(
        body(json!({"type":"agent_settled"})).unwrap(),
        "Finished responding"
    );
    assert_eq!(
        body(json!({"type":"ui_prompt_start","kind":"confirm"})).unwrap(),
        "Needs your input"
    );
    assert_eq!(
        body(json!({"type":"ui_prompt_start","title":" Allow rm? "})).unwrap(),
        "Needs your input: Allow rm?"
    );
    assert_eq!(
        body(json!({"type":"ui_prompt_start","title":"x".repeat(200)}))
            .unwrap()
            .len(),
        18 + 120
    );
    assert_eq!(body(json!({"type":"ui_prompt_end"})), None);
    assert_eq!(
        body(json!({"type":"agent_settled","summary":" Should I ship it? "})).unwrap(),
        "Should I ship it?"
    );
    assert_eq!(
        body(json!({"type":"agent_settled","summary":"z".repeat(300)}))
            .unwrap()
            .len(),
        200
    );
    assert_eq!(payload("  ")["title"], "New Session");
    assert_eq!(payload(&"é".repeat(81))["title"], "é".repeat(80));
}

#[test]
fn push_subscriptions_survive_restart_unsubscribe_and_cap() {
    let state = tempfile::tempdir().unwrap();
    let settings = || Settings {
        origin: "http://127.0.0.1:8787".into(),
        push: Some(Push {
            public: "public-key".into(),
            private: String::new(),
            subject: String::new(),
            client: IsahcWebPushClient::new().unwrap(),
        }),
        ..state_settings(state.path())
    };
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let post = |app: &Arc<App>, path: &str, body: Value| {
        app.inner
            .lock()
            .unwrap()
            .cookies
            .insert("cookie".into(), Instant::now() + Duration::from_secs(60));
        let request = Request::builder()
            .method("POST")
            .uri(path)
            .header("Origin", "http://127.0.0.1:8787")
            .header("Cookie", "rc_session=cookie")
            .body(Body::from(body.to_string()))
            .unwrap();
        let response = runtime.block_on(http(State(app.clone()), request));
        assert_eq!(response.status(), StatusCode::OK);
    };
    let subscribe = |app: &Arc<App>, i: usize| {
        post(
            app,
            "/api/subscribe",
            json!({"subscription":{"endpoint":format!("https://push.example/{i}"),"keys":{"p256dh":"k","auth":"a"}}}),
        )
    };
    let endpoints = |app: &App| -> Vec<String> {
        let inner = app.inner.lock().unwrap();
        inner
            .subscriptions
            .iter()
            .map(|s| s.endpoint.clone())
            .collect()
    };
    let app = Arc::new(App::new(settings()));
    for i in [1, 2, 1] {
        subscribe(&app, i);
    }
    flush(&app);
    assert_eq!(mode(&state.path().join("prc/subscriptions.json")), 0o600);
    drop(app);

    let app = Arc::new(App::new(settings()));
    assert_eq!(
        endpoints(&app),
        ["https://push.example/2", "https://push.example/1"]
    );
    post(
        &app,
        "/api/unsubscribe",
        json!({"endpoint":"https://push.example/2"}),
    );
    for i in 3..=102 {
        subscribe(&app, i);
    }
    flush(&app);
    drop(app);

    let kept = endpoints(&App::new(settings()));
    assert_eq!(kept.len(), MAX_SUBSCRIPTIONS);
    assert_eq!(kept[0], "https://push.example/3");
    assert_eq!(kept[99], "https://push.example/102");
}

fn state_settings(dir: &Path) -> Settings {
    Settings {
        host: String::new(),
        port: 0,
        origin: String::new(),
        token: String::new(),
        password: String::new(),
        push: None,
        state_dir: dir.join("prc"),
    }
}
fn attach(app: &App, process: &str, session: &str, updated_at: u64) -> (Uuid, Sender) {
    let id = Uuid::new_v4();
    let (tx, _rx) = mpsc::unbounded_channel();
    assert!(agent_message(
        app,
        id,
        &tx,
        &mut None,
        &json!({"type":"hello","processId":process,"sessionId":session,"name":"Pi","cwd":"/tmp","branch":"main","busy":false,"updatedAt":updated_at})
    ));
    (id, tx)
}
fn go_offline(app: &App, process: &str) {
    let mut inner = app.inner.lock().unwrap();
    let session = inner.sessions.get_mut(process).unwrap();
    session.owner = None;
    session.tx = None;
}
// Collects every frame the browser receives; the channel closes once the worker finishes the replay.
fn select(app: &App, process: &str) -> Vec<String> {
    let (tx, mut rx) = mpsc::unbounded_channel();
    browser_message(app, &tx, &json!({"type":"select","processId":process}));
    drop(tx);
    let mut frames = Vec::new();
    while let Some(message) = rx.blocking_recv() {
        frames.push(message.to_text().unwrap().to_string());
    }
    frames
}
fn flush(app: &App) {
    let (tx, mut rx) = mpsc::unbounded_channel();
    app.persist
        .send(Job::Replay(String::new(), String::new(), tx))
        .unwrap();
    assert!(rx.blocking_recv().is_none());
}
fn mode(path: &Path) -> u32 {
    fs::metadata(path).unwrap().permissions().mode() & 0o777
}

#[test]
fn ui_prompt_events_mark_session_waiting() {
    let state = tempfile::tempdir().unwrap();
    let app = App::new(state_settings(state.path()));
    let (id, tx) = attach(&app, "p", "s", 0);
    let waiting = || app.inner.lock().unwrap().sessions["p"].info("p")["waiting"].clone();
    assert_eq!(waiting(), false);
    for (kind, expected) in [
        ("ui_prompt_start", true),
        ("ui_prompt_end", false),
        ("ui_prompt_start", true),
    ] {
        assert!(agent_message(
            &app,
            id,
            &tx,
            &mut Some("p".into()),
            &json!({"type":"event","processId":"p","sessionId":"s","event":{"type":kind,"reason":"ui_prompt","kind":"confirm"}})
        ));
        assert_eq!(waiting(), expected);
    }
    let event = |event: Value| {
        assert!(agent_message(
            &app,
            id,
            &tx,
            &mut Some("p".into()),
            &json!({"type":"event","processId":"p","sessionId":"s","event":event})
        ));
        waiting()
    };
    assert_eq!(event(json!({"type":"ui_prompt_end"})), false);
    assert_eq!(event(json!({"type":"agent_settled","asking":true})), true);
    assert_eq!(event(json!({"type":"agent_start"})), false);
    assert_eq!(event(json!({"type":"agent_settled","asking":"yes"})), false);
    assert_eq!(event(json!({"type":"agent_settled","asking":true})), true);
    go_offline(&app, "p");
    assert_eq!(waiting(), false);
}

#[test]
fn queued_follow_ups_are_validated_and_bounded() {
    let state = tempfile::tempdir().unwrap();
    let app = App::new(state_settings(state.path()));
    let (id, tx) = attach(&app, "p", "s", 0);
    let queued = || app.inner.lock().unwrap().sessions["p"].info("p")["queued"].clone();
    assert_eq!(queued(), json!([]));
    let long = "x".repeat(257);
    let many: Vec<_> = (0..=MAX_QUEUED).map(|i| i.to_string()).collect();
    for (list, expected) in [
        (
            json!(["fix tests", 1, long, "then clippy"]),
            json!(["fix tests", "then clippy"]),
        ),
        (json!(many), json!(many[..MAX_QUEUED])),
        (json!("not a list"), json!([])),
    ] {
        assert!(agent_message(
            &app,
            id,
            &tx,
            &mut Some("p".into()),
            &json!({"type":"event","processId":"p","sessionId":"s","event":{"type":"queue_update","queued":list}})
        ));
        assert_eq!(queued(), expected);
    }
    assert!(agent_message(
        &app,
        id,
        &tx,
        &mut Some("p".into()),
        &json!({"type":"hello","processId":"p","sessionId":"s","name":"Pi","cwd":"/tmp","busy":true,"queued":["after reconnect"]})
    ));
    assert_eq!(queued(), json!(["after reconnect"]));
}

#[test]
fn offline_snapshot_survives_restart_and_replays_on_select() {
    let state = tempfile::tempdir().unwrap();
    let app = App::new(state_settings(state.path()));
    let (id, tx) = attach(&app, "p", "s", 1234);
    assert!(agent_message(
        &app,
        id,
        &tx,
        &mut Some("p".into()),
        &json!({"type":"snapshot","processId":"p","sessionId":"s","entries":[{"text":"kept"}]})
    ));
    go_offline(&app, "p");
    let expected =
        json!({"type":"snapshot","processId":"p","sessionId":"s","entries":[{"text":"kept"}]});
    let parse = |frames: Vec<String>| -> Vec<Value> {
        frames
            .iter()
            .map(|f| serde_json::from_str(f).unwrap())
            .collect()
    };
    assert_eq!(parse(select(&app, "p")), vec![expected.clone()]);
    drop(app);

    let app = App::new(state_settings(state.path()));
    let listed = app.inner.lock().unwrap().sessions["p"].info("p");
    assert_eq!(listed["online"], false);
    assert_eq!(listed["busy"], false);
    assert_eq!(listed["name"], "Pi");
    assert_eq!(listed["branch"], "main");
    assert_eq!(listed["updatedAt"], 1234);
    assert_eq!(parse(select(&app, "p")), vec![expected]);
    let (btx, mut brx) = mpsc::unbounded_channel();
    browser_message(
        &app,
        &btx,
        &json!({"type":"prompt","processId":"p","sessionId":"s","text":"hi"}),
    );
    assert_eq!(
        serde_json::from_str::<Value>(brx.try_recv().unwrap().to_text().unwrap()).unwrap(),
        json!({"type":"error","message":"Process is offline"})
    );
    attach(&app, "p", "s2", 0);
    go_offline(&app, "p");
    assert!(select(&app, "p").is_empty());
}

#[test]
fn replay_is_dropped_once_the_agent_reconnects_and_orphans_are_cleaned() {
    let state = tempfile::tempdir().unwrap();
    let app = App::new(state_settings(state.path()));
    let (id, tx) = attach(&app, "p", "s", 1);
    assert!(agent_message(
        &app,
        id,
        &tx,
        &mut Some("p".into()),
        &json!({"type":"snapshot","processId":"p","sessionId":"s","entries":[{"text":"old"}]})
    ));
    go_offline(&app, "p");
    let (btx, mut brx) = mpsc::unbounded_channel();
    {
        let mut inner = app.inner.lock().unwrap();
        app.persist
            .send(Job::Replay("p".into(), "s".into(), btx))
            .unwrap();
        inner.sessions.get_mut("p").unwrap().tx = Some(tx.clone());
    }
    flush(&app);
    assert!(brx.blocking_recv().is_none());
    drop(app);

    let sessions = state.path().join("prc/sessions");
    let old = sessions.join(".stale.tmp");
    let fresh = sessions.join(".fresh.tmp");
    for path in [&old, &fresh] {
        fs::write(path, "transcript").unwrap();
    }
    fs::File::options()
        .write(true)
        .open(&old)
        .unwrap()
        .set_modified(SystemTime::now() - Duration::from_secs(3600))
        .unwrap();
    let _app = App::new(state_settings(state.path()));
    assert!(!old.exists());
    assert!(fresh.exists());
}

#[test]
fn chunked_snapshot_keeps_lone_surrogate_literals() {
    let state = tempfile::tempdir().unwrap();
    let app = App::new(state_settings(state.path()));
    let (id, tx) = attach(&app, "p", "s", 0);
    let parts = [r#""[\"\ud83d""#, r#""\ude00\"]""#];
    for (index, data) in parts.iter().enumerate() {
        assert!(raw_chunk(
            &app,
            id,
            Some("p"),
            &format!(
                r#"{{"type":"snapshot_chunk","processId":"p","sessionId":"s","snapshotId":"a","index":{index},"total":2,"data":{data}}}"#
            )
        ));
    }
    // An incomplete later snapshot must not replace the stored complete one.
    assert!(agent_message(
        &app,
        id,
        &tx,
        &mut Some("p".into()),
        &json!({"type":"snapshot_chunk","processId":"p","sessionId":"s","snapshotId":"b","index":0,"total":2,"data":"[]"})
    ));
    go_offline(&app, "p");
    let check = |frames: Vec<String>| {
        assert_eq!(frames.len(), 2);
        let chunks: Vec<RawChunk> = frames
            .iter()
            .map(|f| serde_json::from_str(f).unwrap())
            .collect();
        for (index, chunk) in chunks.iter().enumerate() {
            assert_eq!(chunk.kind, "snapshot_chunk");
            assert_eq!(
                (chunk.process_id.as_str(), chunk.session_id.as_str()),
                ("p", "s")
            );
            assert!(chunk.snapshot_id != "a" && chunk.snapshot_id == chunks[0].snapshot_id);
            assert_eq!((chunk.index, chunk.total), (index as u64, 2));
            assert_eq!(chunk.data.get(), parts[index]);
        }
    };
    check(select(&app, "p"));
    let stored = state
        .path()
        .join("prc/sessions")
        .join(format!("{}.snapshot.json", file_stem("p")));
    assert_eq!(
        fs::read_to_string(stored).unwrap(),
        format!(
            r#"{{"sessionId":"s","chunks":[{},{}]}}"#,
            parts[0], parts[1]
        )
    );
    drop(app);
    check(select(&App::new(state_settings(state.path())), "p"));
}

#[test]
fn resumed_session_removes_stale_offline_process() {
    let state = tempfile::tempdir().unwrap();
    let app = App::new(state_settings(state.path()));
    attach(&app, "old", "s", 1);
    go_offline(&app, "old");
    attach(&app, "live", "t", 1);
    flush(&app);
    let meta = state
        .path()
        .join("prc/sessions")
        .join(format!("{}.json", file_stem("old")));
    assert!(meta.exists());
    attach(&app, "new", "s", 2);
    attach(&app, "other", "t", 2);
    flush(&app);
    let inner = app.inner.lock().unwrap();
    assert!(!inner.sessions.contains_key("old"));
    assert!(["new", "live", "other"]
        .iter()
        .all(|p| inner.sessions.contains_key(*p)));
    assert!(!meta.exists());
}

#[test]
fn browser_removes_only_offline_sessions_and_their_files() {
    let state = tempfile::tempdir().unwrap();
    let app = App::new(state_settings(state.path()));
    attach(&app, "gone", "s", 1);
    go_offline(&app, "gone");
    attach(&app, "live", "t", 1);
    flush(&app);
    let meta = state
        .path()
        .join("prc/sessions")
        .join(format!("{}.json", file_stem("gone")));
    assert!(meta.exists());
    let (btx, mut brx) = mpsc::unbounded_channel();
    app.inner
        .lock()
        .unwrap()
        .browsers
        .insert(Uuid::new_v4(), (String::new(), btx.clone()));
    let frame = |rx: &mut mpsc::UnboundedReceiver<Message>| -> Value {
        serde_json::from_str(rx.try_recv().unwrap().to_text().unwrap()).unwrap()
    };

    browser_message(&app, &btx, &json!({"type":"remove","processId":"live"}));
    assert_eq!(
        frame(&mut brx),
        json!({"type":"error","message":"Only offline sessions can be removed"})
    );
    assert!(app.inner.lock().unwrap().sessions.contains_key("live"));

    browser_message(&app, &btx, &json!({"type":"remove","processId":"gone"}));
    let listed = frame(&mut brx);
    assert_eq!(listed["type"], "sessions");
    assert!(listed["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .all(|s| s["processId"] != "gone"));
    flush(&app);
    assert!(!meta.exists());
    drop(app);
    let app = App::new(state_settings(state.path()));
    assert!(!app.inner.lock().unwrap().sessions.contains_key("gone"));

    browser_message(&app, &btx, &json!({"type":"remove","processId":"gone"}));
    assert!(brx.try_recv().is_err());
}

#[test]
fn state_files_are_private() {
    let state = tempfile::tempdir().unwrap();
    let app = App::new(state_settings(state.path()));
    let (id, tx) = attach(&app, "p", "s", 0);
    assert!(agent_message(
        &app,
        id,
        &tx,
        &mut Some("p".into()),
        &json!({"type":"snapshot","processId":"p","sessionId":"s","entries":[]})
    ));
    flush(&app);
    let dir = state.path().join("prc");
    let stem = file_stem("p");
    assert_eq!(mode(&dir), 0o700);
    assert_eq!(mode(&dir.join("sessions")), 0o700);
    assert_eq!(mode(&dir.join(format!("sessions/{stem}.json"))), 0o600);
    assert_eq!(
        mode(&dir.join(format!("sessions/{stem}.snapshot.json"))),
        0o600
    );
    let link = state.path().join("link");
    std::os::unix::fs::symlink(&dir, &link).unwrap();
    assert!(ensure_state_dir(&link).is_err());
}

#[test]
fn retention_keeps_fifty_sessions_and_never_prunes_online() {
    let state = tempfile::tempdir().unwrap();
    let app = App::new(state_settings(state.path()));
    for i in 0..55u64 {
        let p = format!("p{i}");
        attach(&app, &p, &format!("s{i}"), i + 1);
        if i > 0 {
            go_offline(&app, &p);
        }
    }
    flush(&app);
    {
        let inner = app.inner.lock().unwrap();
        assert_eq!(inner.sessions.len(), 50);
        assert!(inner.sessions.contains_key("p0"));
        assert!((1..=5).all(|i| !inner.sessions.contains_key(&format!("p{i}"))));
    }
    let sessions = state.path().join("prc/sessions");
    let count = || {
        fs::read_dir(&sessions)
            .unwrap()
            .filter(|e| e.as_ref().unwrap().file_name().len() == 69)
            .count()
    };
    assert_eq!(count(), 50);
    drop(app);
    let extra = StoredMeta {
        process_id: "extra".into(),
        session_id: "x".into(),
        name: String::new(),
        cwd: String::new(),
        branch: None,
        updated_at: 0,
        model: None,
        thinking_level: None,
        context: None,
    };
    fs::write(
        sessions.join(format!("{}.json", file_stem("extra"))),
        serde_json::to_vec(&extra).unwrap(),
    )
    .unwrap();
    let app = App::new(state_settings(state.path()));
    flush(&app);
    assert_eq!(app.inner.lock().unwrap().sessions.len(), 50);
    assert!(!app.inner.lock().unwrap().sessions.contains_key("extra"));
    assert_eq!(count(), 50);
}

#[test]
fn model_fields_persist_and_model_commands_are_validated() {
    let state = tempfile::tempdir().unwrap();
    let app = App::new(state_settings(state.path()));
    let (id, (tx, mut agent)) = (Uuid::new_v4(), mpsc::unbounded_channel());
    let (other, mut other_rx) = mpsc::unbounded_channel();
    app.inner
        .lock()
        .unwrap()
        .browsers
        .insert(Uuid::new_v4(), (String::new(), other));
    let model = json!({"provider":"anthropic","id":"sonnet","name":"Sonnet","reasoning":true,"thinkingLevels":["off","high"]});
    let models = json!([{"provider":"anthropic","id":"sonnet","name":"Sonnet","reasoning":true},{"provider":"openai","id":"mini","name":"Mini","reasoning":false}]);
    assert!(agent_message(
        &app,
        id,
        &tx,
        &mut None,
        &json!({"type":"hello","processId":"p","sessionId":"s","name":"Pi","cwd":"/tmp","branch":"","busy":false,"model":model,"thinkingLevel":"high","context":{"tokens":null,"contextWindow":200000},"models":[models[0], {"provider":"bad"}, models[1]]})
    ));
    agent.try_recv().unwrap();
    other_rx.try_recv().unwrap();
    let listed = app.inner.lock().unwrap().sessions["p"].info("p");
    assert_eq!(listed["model"], model);
    assert_eq!(listed["thinkingLevel"], "high");
    assert_eq!(listed["branch"], Value::Null);
    assert!(listed.get("models").is_none());
    assert_eq!(
        listed["context"],
        json!({"tokens":null,"contextWindow":200000})
    );
    // A later event carries the agent's fresh gauge; an invalid one keeps the last good value.
    for usage in [
        json!({"tokens":50000,"contextWindow":200000}),
        json!({"tokens":-1,"contextWindow":200000}),
    ] {
        assert!(agent_message(
            &app,
            id,
            &tx,
            &mut Some("p".into()),
            &json!({"type":"event","processId":"p","sessionId":"s","event":{"type":"agent_settled","contextUsage":usage}})
        ));
    }
    while other_rx.try_recv().is_ok() {}
    while agent.try_recv().is_ok() {}
    assert_eq!(
        app.inner.lock().unwrap().sessions["p"].info("p")["context"],
        json!({"tokens":50000,"contextWindow":200000})
    );

    let (btx, mut brx) = mpsc::unbounded_channel();
    let mut ask = |v: Value| {
        browser_message(&app, &btx, &v);
        brx.try_recv()
            .ok()
            .map(|m| serde_json::from_str::<Value>(m.to_text().unwrap()).unwrap())
    };
    assert_eq!(
        ask(json!({"type":"models","processId":"p"})),
        Some(json!({"type":"models","processId":"p","sessionId":"s","models":models}))
    );
    let agent_frame = |agent: &mut mpsc::UnboundedReceiver<Message>| {
        serde_json::from_str::<Value>(agent.try_recv().unwrap().to_text().unwrap()).unwrap()
    };
    assert_eq!(
        agent_frame(&mut agent),
        json!({"type":"models","sessionId":"s"})
    );
    assert!(other_rx.try_recv().is_err());
    let stale = Some(json!({"type":"error","message":"Invalid or stale command"}));
    for bad in [
        json!({"type":"set_model","processId":"p","sessionId":"s","provider":"openai","modelId":"hidden"}),
        json!({"type":"set_model","processId":"p","sessionId":"s","provider":"openai"}),
        json!({"type":"set_model","processId":"p","sessionId":"old","provider":"openai","modelId":"mini"}),
        json!({"type":"set_thinking","processId":"p","sessionId":"s","level":"extreme"}),
        json!({"type":"set_thinking","processId":"p","sessionId":"old","level":"high"}),
    ] {
        assert_eq!(ask(bad), stale);
    }
    assert!(agent.try_recv().is_err());
    assert_eq!(
        ask(
            json!({"type":"set_model","processId":"p","sessionId":"s","provider":"openai","modelId":"mini"})
        ),
        None
    );
    assert_eq!(
        serde_json::from_str::<Value>(agent.try_recv().unwrap().to_text().unwrap()).unwrap(),
        json!({"type":"set_model","sessionId":"s","provider":"openai","modelId":"mini"})
    );
    assert_eq!(
        ask(json!({"type":"set_thinking","processId":"p","sessionId":"s","level":"xhigh"})),
        None
    );
    assert_eq!(
        serde_json::from_str::<Value>(agent.try_recv().unwrap().to_text().unwrap()).unwrap(),
        json!({"type":"set_thinking","sessionId":"s","level":"xhigh"})
    );

    let refreshed =
        json!([{"provider":"anthropic","id":"sonnet","name":"Sonnet","reasoning":true}]);
    let mut process = Some("p".to_string());
    assert!(agent_message(
        &app,
        id,
        &tx,
        &mut process,
        &json!({"type":"models","processId":"p","sessionId":"old","models":[]})
    ));
    assert!(other_rx.try_recv().is_err());
    assert!(agent_message(
        &app,
        id,
        &tx,
        &mut process,
        &json!({"type":"models","processId":"p","sessionId":"s","models":[refreshed[0], {"provider":"openai","id":"mini"}]})
    ));
    assert_eq!(
        serde_json::from_str::<Value>(other_rx.try_recv().unwrap().to_text().unwrap()).unwrap(),
        json!({"type":"models","processId":"p","sessionId":"s","models":refreshed})
    );
    assert_eq!(
        ask(
            json!({"type":"set_model","processId":"p","sessionId":"s","provider":"openai","modelId":"mini"})
        ),
        stale
    );
    let oversized: Vec<_> = (0..=MAX_MODELS)
        .map(|i| json!({"provider":"p","id":i.to_string(),"name":"n","reasoning":false}))
        .collect();
    assert!(agent_message(
        &app,
        id,
        &tx,
        &mut process,
        &json!({"type":"models","processId":"p","sessionId":"s","models":oversized})
    ));
    assert_eq!(
        ask(json!({"type":"models","processId":"p"})),
        Some(json!({"type":"models","processId":"p","sessionId":"s","models":refreshed}))
    );
    assert_eq!(
        agent_frame(&mut agent),
        json!({"type":"models","sessionId":"s"})
    );

    let offline = Some(json!({"type":"error","message":"Process is offline"}));
    assert_eq!(ask(json!({"type":"models","processId":"nope"})), None);
    go_offline(&app, "p");
    assert_eq!(ask(json!({"type":"models","processId":"p"})), None);
    assert!(agent.try_recv().is_err());
    assert_eq!(
        ask(json!({"type":"set_thinking","processId":"p","sessionId":"s","level":"high"})),
        offline
    );
    flush(&app);
    drop(app);

    let sessions = state.path().join("prc/sessions");
    fs::write(
        sessions.join(format!("{}.json", file_stem("old"))),
        r#"{"processId":"old","sessionId":"o","name":"Old","cwd":"/","updatedAt":5}"#,
    )
    .unwrap();
    let app = App::new(state_settings(state.path()));
    {
        let inner = app.inner.lock().unwrap();
        let restored = inner.sessions["p"].info("p");
        assert_eq!(restored["model"], model);
        assert_eq!(restored["thinkingLevel"], "high");
        assert!(inner.sessions["p"].models.is_empty());
        let old = inner.sessions["old"].info("old");
        assert_eq!(
            (old["name"].clone(), old["model"].clone()),
            (json!("Old"), Value::Null)
        );
        assert!(old["thinkingLevel"].is_null());
    }

    let long = "x".repeat(257);
    let many: Vec<_> = (0..=MAX_MODELS)
        .map(|i| json!({"provider":"p","id":i.to_string(),"name":"n","reasoning":false}))
        .collect();
    for (model, level, models) in [
        (
            json!({"provider":"a","id":"b","name":long,"reasoning":true,"thinkingLevels":["off"]}),
            json!("extreme"),
            json!(many),
        ),
        (
            json!({"provider":"a","id":"b","name":"n","reasoning":true,"thinkingLevels":["huge"]}),
            json!(7),
            json!([{"provider":"a","id":"b","name":"n"}]),
        ),
        (json!("sonnet"), Value::Null, json!({"not":"a list"})),
    ] {
        let (tx, mut agent) = mpsc::unbounded_channel();
        assert!(agent_message(
            &app,
            Uuid::new_v4(),
            &tx,
            &mut None,
            &json!({"type":"hello","processId":"p","sessionId":"s","name":"Pi","cwd":"/tmp","busy":false,"model":model,"thinkingLevel":level,"models":models})
        ));
        assert_eq!(
            serde_json::from_str::<Value>(agent.try_recv().unwrap().to_text().unwrap()).unwrap()
                ["type"],
            "history"
        );
        let inner = app.inner.lock().unwrap();
        let session = &inner.sessions["p"];
        assert!(
            session.model.is_none()
                && session.thinking_level.is_none()
                && session.models.is_empty()
        );
    }
}

#[test]
fn rename_is_validated_and_forwarded_only_to_the_agent() {
    let state = tempfile::tempdir().unwrap();
    let app = App::new(state_settings(state.path()));
    let (tx, mut agent) = mpsc::unbounded_channel();
    assert!(agent_message(
        &app,
        Uuid::new_v4(),
        &tx,
        &mut None,
        &json!({"type":"hello","processId":"p","sessionId":"s","name":"Pi","cwd":"/tmp","busy":false})
    ));
    agent.try_recv().unwrap();
    let (btx, mut brx) = mpsc::unbounded_channel();
    let mut ask = |v: Value| {
        browser_message(&app, &btx, &v);
        brx.try_recv()
            .ok()
            .map(|m| serde_json::from_str::<Value>(m.to_text().unwrap()).unwrap())
    };
    let stale = Some(json!({"type":"error","message":"Invalid or stale command"}));
    for bad in [
        json!({"type":"rename","processId":"p","sessionId":"old","name":"New"}),
        json!({"type":"rename","processId":"p","sessionId":"s","name":7}),
        json!({"type":"rename","processId":"p","sessionId":"s","name":"é".repeat(1025)}),
    ] {
        assert_eq!(ask(bad), stale);
    }
    assert!(agent.try_recv().is_err());
    assert_eq!(
        ask(json!({"type":"rename","processId":"p","sessionId":"s","name":"é".repeat(1024)})),
        None
    );
    assert_eq!(
        serde_json::from_str::<Value>(agent.try_recv().unwrap().to_text().unwrap()).unwrap(),
        json!({"type":"rename","sessionId":"s","name":"é".repeat(1024)})
    );
    go_offline(&app, "p");
    assert_eq!(
        ask(json!({"type":"rename","processId":"p","sessionId":"s","name":"New"})),
        Some(json!({"type":"error","message":"Process is offline"}))
    );
    assert!(agent.try_recv().is_err());
}

#[test]
fn loopback_origin_port_check_only_applies_to_loopback_binds() {
    let origin = Url::parse("http://localhost:18787").unwrap();
    assert!(loopback_port_mismatch("127.0.0.1", &origin, 8787));
    assert!(!loopback_port_mismatch("127.0.0.1", &origin, 18787));
    assert!(!loopback_port_mismatch("0.0.0.0", &origin, 8787));
    assert!(!loopback_port_mismatch(
        "127.0.0.1",
        &Url::parse("https://pi.tail.example").unwrap(),
        8787
    ));
}
