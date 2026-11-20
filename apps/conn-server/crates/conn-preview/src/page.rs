//! Browser-side work uses Playwright's pinned injected DOM engine, with Rust owning the transport.
use crate::{Browser, Error, spec::spec};
use serde_json::{Value, json};

pub(crate) async fn utility(browser: &Browser, session: &str, body: &str) -> Result<Value, Error> {
    let tree = browser
        .send("Page.getFrameTree", json!({}), Some(session))
        .await?;
    let frame = tree
        .pointer("/frameTree/frame/id")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            Error("The page changed while capturing its snapshot. Take another snapshot.".into())
        })?;
    let world = browser
        .send(
            "Page.createIsolatedWorld",
            json!({"frameId":frame,"worldName":"t3-preview"}),
            Some(session),
        )
        .await?;
    let context = world
        .get("executionContextId")
        .and_then(Value::as_u64)
        .ok_or_else(|| Error("The preview page has no execution context.".into()))?;
    let present=browser.send("Runtime.evaluate",json!({"contextId":context,"expression":"!!globalThis.__connInjected","returnByValue":true}),Some(session)).await?;
    if present.pointer("/result/value").and_then(Value::as_bool) != Some(true) {
        let source = include_str!("injected.js");
        let script = format!(
            "(()=>{{const module={{exports:{{}}}};{source}\nglobalThis.__connInjected=new (module.exports.InjectedScript())(window,{{isUnderTest:false,sdkLanguage:'javascript',testIdAttributeName:'data-testid',stableRafCount:1,browserName:'chromium',customEngines:[],isUtilityWorld:true}});return true;}})()"
        );
        evaluate_world(browser, session, context, &script).await?;
    }
    let script = format!("(async()=>{{const injected=globalThis.__connInjected;{body}}})()");
    evaluate_world(browser, session, context, &script).await
}
async fn evaluate_world(
    browser: &Browser,
    session: &str,
    context: u64,
    script: &str,
) -> Result<Value, Error> {
    let value=browser.send("Runtime.evaluate",json!({"contextId":context,"expression":script,"returnByValue":true,"awaitPromise":true}),Some(session)).await?;
    if let Some(details) = value.get("exceptionDetails") {
        return Err(Error(
            details
                .pointer("/exception/description")
                .or_else(|| details.get("text"))
                .and_then(Value::as_str)
                .unwrap_or("The browser page operation failed.")
                .into(),
        ));
    }
    Ok(value
        .pointer("/result/value")
        .cloned()
        .unwrap_or(Value::Null))
}

pub(crate) async fn secrets(browser: &Browser, session: &str) -> Result<Vec<String>, Error> {
    let script = &spec()?.scripts.sensitive;
    let values = utility(browser, session, &format!("return {script};")).await?;
    let values = values
        .as_array()
        .ok_or_else(|| Error("The browser could not check hidden values.".into()))?;
    if values.len() > 64 {
        return Err(Error(
            "The browser page holds too many hidden values to read safely.".into(),
        ));
    }
    let mut result = Vec::new();
    for value in values {
        if let Some(value) = value.as_str() {
            if value.len() > 4096 {
                return Err(Error(
                    "A password field holds a value too long to hide, so no snapshot was taken."
                        .into(),
                ));
            }
            if !value.is_empty() {
                result.push(value.to_owned());
            }
        }
    }
    Ok(result)
}
pub(crate) fn redact(value: &mut Value, secrets: &[String]) {
    let mut variants = Vec::new();
    for secret in secrets.iter().filter(|s| !s.is_empty()) {
        variants.push(secret.clone());
        variants.push(conn_support::ids::encode_component(secret));
        if let Ok(escaped) = serde_json::to_string(secret)
            && let Some(inner) = escaped.strip_prefix('"').and_then(|s| s.strip_suffix('"'))
        {
            variants.push(inner.into());
        }
    }
    variants.sort_by_key(|s| std::cmp::Reverse(s.len()));
    variants.dedup();
    redact_in(value, &variants);
}
fn redact_in(value: &mut Value, variants: &[String]) {
    let redact_text = |text: &str| {
        if variants
            .iter()
            .any(|s| s.encode_utf16().count() < 4 && s == text)
        {
            return "[redacted]".into();
        }
        let mut text = text.to_owned();
        for secret in variants.iter().filter(|s| s.encode_utf16().count() >= 4) {
            text = text.replace(secret, "[redacted]");
        }
        text
    };
    match value {
        Value::String(text) => *text = redact_text(text),
        Value::Array(items) => {
            for item in items {
                redact_in(item, variants);
            }
        }
        Value::Object(fields) => {
            let original = std::mem::take(fields);
            for (key, mut value) in original {
                redact_in(&mut value, variants);
                fields.insert(redact_text(&key), value);
            }
        }
        _ => {}
    }
}

pub(crate) async fn snapshot(
    browser: &Browser,
    session: &str,
    input: &Value,
    generation: &str,
) -> Result<Value, Error> {
    let tree = browser
        .send("Page.getFrameTree", json!({}), Some(session))
        .await?;
    // Child-frame snapshots fail closed until their DOM readers can be verified.
    if tree
        .pointer("/frameTree/childFrames")
        .and_then(Value::as_array)
        .is_some_and(|v| !v.is_empty())
    {
        return Err(Error("A frame on the page didn't answer within 1000ms, so its content couldn't be checked for hidden values. Try the snapshot again.".into()));
    }
    let dotted_script = &spec()?.scripts.dotted;
    let read_dotted = format!("return {dotted_script};");
    let before = utility(browser, session, &read_dotted).await?;
    let mut page=utility(browser,session,&format!("globalThis.__connRefGeneration={};const result={};const tree=injected.ariaSnapshot(document.body,{{mode:'ai',boxes:true}});const MASKED_VALUE='••••••••';const ServerBrowserOperationError=Error;{}const dotted=dottedPattern({});result.url=withoutDataPayload(result.url);const safeTree=withoutTreeDataPayloads(tree);result.visibleText=dotted?result.visibleText.replace(dotted,MASKED_VALUE):result.visibleText;result.accessibilityTree=(dotted?maskTree(safeTree,dotted):safeTree).replace(/\\[ref=((?:f\\d+)?e\\d+)\\]/g,(_,ref)=>'[ref=t3-'+globalThis.__connRefGeneration+'-'+ref+']');return result;",json!(generation),spec()?.scripts.snapshot,spec()?.scripts.mask,before)).await?;
    let metrics = browser
        .send("Page.getLayoutMetrics", json!({}), Some(session))
        .await?;
    let width = metrics
        .pointer("/cssVisualViewport/clientWidth")
        .and_then(Value::as_f64)
        .unwrap_or(1280.);
    let height = metrics
        .pointer("/cssVisualViewport/clientHeight")
        .and_then(Value::as_f64)
        .unwrap_or(800.);
    let scale = (1280. / (width * 2.)).min(1.);
    let save = input.get("save").and_then(Value::as_bool) == Some(true);
    if save {
        let full = browser
            .send(
                "Page.captureScreenshot",
                json!({"format":"png","captureBeyondViewport":false}),
                Some(session),
            )
            .await?;
        page["fullScreenshot"] = json!({"data":full.get("data")});
    }
    let data = if input.get("includeImage").and_then(Value::as_bool) == Some(true)
        || input.get("save").and_then(Value::as_bool) == Some(true)
    {
        let screenshot=browser.send("Page.captureScreenshot",json!({"format":"png","captureBeyondViewport":false,"clip":{"x":0,"y":0,"width":width,"height":height,"scale":scale}}),Some(session)).await?;
        screenshot
            .get("data")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    } else {
        String::new()
    };
    let after = utility(browser, session, &read_dotted).await?;
    if before != after {
        return Err(Error(
            "The page changed while capturing its snapshot. Take another snapshot.".into(),
        ));
    }

    for key in ["visibleText", "accessibilityTree"] {
        if let Some(text) = page.get(key).and_then(Value::as_str).map(str::to_owned) {
            page[key] = json!(text.chars().take(20_000).collect::<String>());
        }
    }
    page["consoleEntries"] = json!([]);
    page["networkEntries"] = json!([]);
    page["actionTimeline"] = json!([]);
    page["screenshot"] = json!({"mimeType":"image/png","width":(width*2.*scale).round() as u64,"height":(height*2.*scale).round() as u64,"data":data});
    Ok(page)
}

const LOCATOR_JS: &str = r#"const raw=input.locator??input.selector;let selector=raw;if(selector?.startsWith('aria-ref=')){const match=/^aria-ref=t3-(\S+?)-((?:f\d+)?e\d+)$/.exec(selector);if(!match||match[1]!==globalThis.__connRefGeneration)throw Error('__conn_stale_ref');selector='aria-ref='+match[2];}const parsed=selector===undefined?null:injected.parseSelector(selector);const element=parsed===null?document.activeElement:injected.querySelector(parsed,document,true);"#;

pub(crate) fn upload_paths(input: &Value) -> Result<&Vec<Value>, Error> {
    let paths = input
        .get("paths")
        .and_then(Value::as_array)
        .ok_or_else(|| Error("Upload paths are missing.".into()))?;
    for path in paths {
        let path = path
            .as_str()
            .ok_or_else(|| Error("Upload paths are missing.".into()))?;
        if !std::path::Path::new(path).is_absolute() {
            return Err(Error(format!("Upload paths must be absolute: {path}")));
        }
    }
    Ok(paths)
}

pub(crate) async fn action(
    browser: &Browser,
    session: &str,
    action: &str,
    input: &Value,
    encoder: Option<&str>,
) -> Result<Value, Error> {
    let input_json = serde_json::to_string(input).map_err(crate::err)?;
    if action == "press" {
        return press(browser, session, input).await;
    }
    if action == "scroll" {
        utility(browser,session,&format!("const input={input_json};{LOCATOR_JS}if(!element&&parsed)throw Error('The target element is not attached.');(parsed?element:window).scrollBy(input.deltaX??0,input.deltaY??0);return null;")).await?;
        return Ok(json!({}));
    }
    if action == "type" {
        let result=utility(browser,session,&format!("const input={input_json};{LOCATOR_JS}if(!element)throw Error('__conn_not_editable');const state=await injected.checkElementStates(element,['visible','enabled','editable']);if(state&&state!=='done')throw Error('__conn_not_editable');if(input.clear)return injected.fill(element,input.text);injected.focusNode(element,false);return 'needsinput';")).await?;
        if result.as_str() == Some("needsinput") {
            browser
                .send(
                    "Input.insertText",
                    json!({"text":input.get("text").and_then(Value::as_str).unwrap_or_default()}),
                    Some(session),
                )
                .await?;
        }
        return Ok(json!({}));
    }
    if action == "select" {
        return utility(browser,session,&format!("const input={input_json};{LOCATOR_JS}if(!element||element.tagName!=='SELECT')throw Error('__conn_not_editable');const values=input.values.map(v=>{{const option=[...element.options].find(o=>o.value===v)??[...element.options].find(o=>o.label.trim()===v.trim());return {{value:option?.value??v}};}});const selected=injected.selectOptions(element,values);return {{selected}};")).await;
    }
    if action == "upload" {
        let paths = input.get("paths");
        let node=utility(browser,session,&format!("const input={input_json};{LOCATOR_JS}if(!element||element.tagName!=='INPUT'||element.type!=='file')throw Error('__conn_not_editable');element.setAttribute('data-conn-upload', 'active');return true;")).await?;
        if node != true {
            return Err(Error("The upload target is not available.".into()));
        }
        let result = async {
            let doc = browser
                .send("DOM.getDocument", json!({}), Some(session))
                .await?;
            let root = doc
                .pointer("/root/nodeId")
                .and_then(Value::as_u64)
                .ok_or_else(|| Error("The upload document is not available.".into()))?;
            let node = browser
                .send(
                    "DOM.querySelector",
                    json!({"nodeId":root,"selector":"[data-conn-upload=active]"}),
                    Some(session),
                )
                .await?;
            browser
                .send(
                    "DOM.setFileInputFiles",
                    json!({"nodeId":node.get("nodeId"),"files":paths}),
                    Some(session),
                )
                .await?;
            Ok::<_, Error>(())
        }
        .await;
        let cleared = utility(browser, session, "for (const node of document.querySelectorAll('[data-conn-upload=active]')) node.removeAttribute('data-conn-upload');return null;").await;
        result?;
        cleared?;
        return Ok(json!({}));
    }
    if action == "drag" {
        let from = point(browser, session, &json!({"locator":input.get("source")})).await?;
        let to = point(browser, session, &json!({"locator":input.get("target")})).await?;
        cursor(browser, encoder, &from, false).await;
        mouse(browser, session, "mouseMoved", &from, "none", 0).await?;
        mouse(browser, session, "mousePressed", &from, "left", 1).await?;
        mouse(browser, session, "mouseMoved", &to, "left", 1).await?;
        cursor(browser, encoder, &to, false).await;
        mouse(browser, session, "mouseReleased", &to, "left", 1).await?;
        return Ok(json!({}));
    }
    let point = point(browser, session, input).await?;
    cursor(browser, encoder, &point, action == "click").await;
    mouse(browser, session, "mouseMoved", &point, "none", 0).await?;
    if action == "click" {
        let button = input
            .get("button")
            .and_then(Value::as_str)
            .unwrap_or("left");
        let count = input.get("clickCount").and_then(Value::as_u64).unwrap_or(1);
        for click in 1..=count {
            mouse(browser, session, "mousePressed", &point, button, click).await?;
            mouse(browser, session, "mouseReleased", &point, button, click).await?;
        }
    }
    Ok(json!({}))
}
async fn point(browser: &Browser, session: &str, input: &Value) -> Result<Value, Error> {
    if input.get("x").is_some() && input.get("y").is_some() {
        return Ok(json!({"x":input.get("x"),"y":input.get("y")}));
    }
    let input = serde_json::to_string(input).map_err(crate::err)?;
    loop {
        let result=utility(browser,session,&format!("const input={input};{LOCATOR_JS}if(!element)throw Error('The target element is not attached.');const state=await injected.checkElementStates(element,['visible','stable','enabled']);if(state)throw Error('The target element is not ready.');element.scrollIntoView({{block:'center',inline:'center'}});const rect=element.getBoundingClientRect();const point={{x:Math.max(0,rect.x)+Math.min(rect.width,innerWidth-Math.max(0,rect.x))/2,y:Math.max(0,rect.y)+Math.min(rect.height,innerHeight-Math.max(0,rect.y))/2}};const hit=injected.expectHitTarget(point,element);if(hit!=='done')throw Error('The target element is obscured.');return point;")).await;
        match result {
            Err(error) if error.0.contains("The target element is") => {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await
            }
            result => return result,
        }
    }
}
async fn mouse(
    browser: &Browser,
    session: &str,
    kind: &str,
    point: &Value,
    button: &str,
    count: u64,
) -> Result<(), Error> {
    browser.send("Input.dispatchMouseEvent",json!({"type":kind,"x":point.get("x"),"y":point.get("y"),"button":button,"clickCount":count}),Some(session)).await?;
    Ok(())
}
async fn press(browser: &Browser, session: &str, input: &Value) -> Result<Value, Error> {
    let mut chord = input
        .get("modifiers")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let mut building = String::new();
    for c in input
        .get("key")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .chars()
    {
        if c == '+' && !building.is_empty() {
            chord.push(std::mem::take(&mut building));
        } else {
            building.push(c);
        }
    }
    chord.push(building);
    let keys = &spec()?.keys;
    let descriptions = chord
        .iter()
        .map(|name| {
            keys.get(if name == "ControlOrMeta" {
                "Control"
            } else {
                name.as_str()
            })
            .cloned()
            .ok_or_else(|| Error(format!("keyboard.press: Unknown key: \"{name}\"")))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut modifiers = 0u64;
    for description in &descriptions {
        modifiers |= modifier(description);
        dispatch_key(browser, session, description, modifiers, true).await?;
    }
    for description in descriptions.iter().rev() {
        modifiers &= !modifier(description);
        dispatch_key(browser, session, description, modifiers, false).await?;
    }
    Ok(json!({}))
}
fn modifier(description: &Value) -> u64 {
    match description.get("key").and_then(Value::as_str) {
        Some("Alt") => 1,
        Some("Control") => 2,
        Some("Meta") => 4,
        Some("Shift") => 8,
        _ => 0,
    }
}
async fn dispatch_key(
    browser: &Browser,
    session: &str,
    description: &Value,
    modifiers: u64,
    down: bool,
) -> Result<(), Error> {
    let description = if modifiers & 8 != 0 {
        description.get("shifted").unwrap_or(description)
    } else {
        description
    };
    let text = if modifiers & 7 == 0 {
        description
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or_default()
    } else {
        ""
    };
    browser.send("Input.dispatchKeyEvent",json!({"type":if !down{"keyUp"}else if text.is_empty(){"rawKeyDown"}else{"keyDown"},"key":description.get("key"),"code":description.get("code"),"windowsVirtualKeyCode":description.get("keyCode"),"location":description.get("location"),"text":if down{text}else{""},"modifiers":modifiers}),Some(session)).await?;
    Ok(())
}
pub(crate) async fn wait_for(
    browser: &Browser,
    session: &str,
    input: &Value,
) -> Result<Value, Error> {
    let timeout = input
        .get("timeoutMs")
        .and_then(Value::as_u64)
        .unwrap_or(15_000);
    let script = format!(
        "const input={input};{LOCATOR_JS}return (parsed===null||injected.querySelectorAll(parsed,document).length>0)&&(input.text===undefined||(document.body?.innerText??'').includes(input.text))&&(input.urlIncludes===undefined||location.href.includes(input.urlIncludes));"
    );
    let result = tokio::time::timeout(std::time::Duration::from_millis(timeout), async {
        let mut interval = tokio::time::interval(std::time::Duration::from_millis(100));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            match utility(browser, session, &script).await {
                Ok(value) if value == true => return Ok(json!({})),
                Err(error) if error.0.contains("__conn_stale_ref") => return Err(error),
                _ => {}
            }
        }
    })
    .await;
    result.unwrap_or_else(|_| {
        Err(Error(format!(
            "Preview automation waitFor timed out after {timeout}ms."
        )))
    })
}

pub(crate) async fn target_timeout(browser: &Browser, session: &str, input: &Value) -> String {
    let selector = input.get("locator").or_else(|| input.get("selector"));
    let Some(selector) = selector else {
        return String::new();
    };
    let target = serde_json::to_string(selector).unwrap_or_default();
    let target = if target.chars().count() > 200 {
        format!("{}...", target.chars().take(200).collect::<String>())
    } else {
        target
    };
    let script = format!(
        "const input={input};{LOCATOR_JS}return injected.querySelectorAll(parsed,document).length;"
    );
    match tokio::time::timeout(
        std::time::Duration::from_millis(250),
        utility(browser, session, &script),
    )
    .await
    {
        Ok(Ok(value)) if value.as_u64() == Some(0) => format!(
            " The click may have happened and removed its target or navigated; check the page before retrying. No element matches {target} after the timeout; take a fresh snapshot and use its locator."
        ),
        Ok(Ok(_)) => format!(
            " The click may have happened; check the page before retrying. {target} still matches an element after the timeout."
        ),
        _ => format!(
            " The click may have happened; check the page before retrying. Whether {target} still matches an element is unknown."
        ),
    }
}

async fn cursor(browser: &Browser, encoder: Option<&str>, point: &Value, click: bool) {
    if let Some(encoder) = encoder {
        let expression = format!(
            "globalThis.__t3Recorder.cursor({},{},{click})",
            point.get("x").unwrap_or(&Value::Null),
            point.get("y").unwrap_or(&Value::Null)
        );
        let _ = browser
            .send(
                "Runtime.evaluate",
                json!({"expression":expression}),
                Some(encoder),
            )
            .await;
    }
}

/// `fillCredential` (`packages/shared/src/previewPage.ts`): inserts a test-login value into the
/// input `fieldExpression` finds. The value goes only to CDP: never into an expression, a
/// result, an error or the action timeline.
pub(crate) async fn fill_credential(
    browser: &Browser,
    session: &str,
    input: &Value,
    remember: impl Fn(&str),
) -> Result<Value, Error> {
    const GROUP: &str = "t3code-credential-fill";
    let status = |status: &str| Ok(json!({ "status": status }));
    let send = |method: &'static str, params: Value| browser.send(method, params, Some(session));
    let expected = input
        .get("expectedOrigin")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let field = input.get("field").cloned().unwrap_or(Value::Null);
    let origin_now = || async {
        send(
            "Runtime.evaluate",
            json!({"expression": "location.origin", "returnByValue": true}),
        )
        .await
        .ok()
        .and_then(|r| {
            r.pointer("/result/value")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
    };
    if origin_now().await.as_deref() != Some(expected) {
        return status("origin_mismatch");
    }
    let scripts = &spec()?.scripts;
    let call = |object: String, declaration: &'static str, arguments: Vec<Value>| async move {
        let response = send(
            "Runtime.callFunctionOn",
            json!({
                "objectId": object, "functionDeclaration": declaration,
                "arguments": arguments.into_iter().map(|value| json!({"value": value})).collect::<Vec<_>>(),
                "returnByValue": true, "userGesture": true,
            }),
        )
        .await
        .ok()?;
        if response.get("exceptionDetails").is_some() {
            return None;
        }
        response
            .pointer("/result/value")
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    let outcome = async {
        let found = send(
            "Runtime.evaluate",
            json!({"expression": input.get("fieldExpression"), "returnByValue": false,
                "objectGroup": GROUP}),
        )
        .await
        .ok();
        let object = found
            .as_ref()
            .filter(|f| f.get("exceptionDetails").is_none())
            .filter(|f| f.pointer("/result/subtype").and_then(Value::as_str) == Some("node"))
            .and_then(|f| f.pointer("/result/objectId").and_then(Value::as_str))
            .map(str::to_owned);
        let Some(object) = object else {
            return "field_not_found";
        };
        match call(
            object.clone(),
            &scripts.credential_prepare,
            vec![field.clone()],
        )
        .await
        .as_deref()
        {
            Some("ready") => {}
            Some("not_editable") => return "not_editable",
            _ => return "insert_failed",
        }
        // The page may have navigated while the field was found.
        if origin_now().await.as_deref() != Some(expected) {
            return "origin_mismatch";
        }
        let value = input.get("value").cloned().unwrap_or(Value::Null);
        // Remembered before it goes in, so redaction covers it from then on.
        if field != "username"
            && let Some(secret) = value.as_str()
        {
            remember(secret);
        }
        match call(
            object,
            &scripts.credential_insert,
            vec![field, value, json!(expected), json!(false)],
        )
        .await
        .as_deref()
        {
            Some("filled") => "filled",
            Some("origin_mismatch") => "origin_mismatch",
            _ => "insert_failed",
        }
    }
    .await;
    let _ = send("Runtime.releaseObjectGroup", json!({"objectGroup": GROUP})).await;
    status(outcome)
}

/// `credentialFieldExpression(field, selector)`: the page expression that finds the input.
pub fn credential_field_expression(field: &str, selector: Option<&str>) -> Result<String, Error> {
    let template = &spec()?.scripts.credential_field;
    Ok(template
        .replacen("\"__T3_FIELD__\"", &json!(field).to_string(), 1)
        .replacen("\"__T3_SELECTOR__\"", &json!(selector).to_string(), 1))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn redacts_keys_encoded_values_and_overlapping_secrets_but_keeps_short_substrings() {
        let mut value = json!({"pass word":"raw pass word and pass%20word", "short":"x is fine", "exact":"x", "json":"line\\nsecret"});
        redact(
            &mut value,
            &[
                "pass word".into(),
                "pass".into(),
                "x".into(),
                "line\nsecret".into(),
            ],
        );
        assert_eq!(
            value,
            json!({"[redacted]":"raw [redacted] and [redacted]","short":"x is fine","exact":"[redacted]","json":"[redacted]"})
        );
    }
}
