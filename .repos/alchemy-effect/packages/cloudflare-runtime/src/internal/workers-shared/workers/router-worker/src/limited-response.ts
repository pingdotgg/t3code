// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
function formatDate(date: Date) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    // en-CA for YYYY-MM-DD
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23", // Ensures 24-hour format
    timeZone: "UTC",
  });
  const parts = formatter.formatToParts(date);
  let year, month, day, hour, minute, second;
  for (const part of parts) {
    switch (part.type) {
      case "year":
        year = part.value;
        break;
      case "month":
        month = part.value;
        break;
      case "day":
        day = part.value;
        break;
      case "hour":
        hour = part.value;
        break;
      case "minute":
        minute = part.value;
        break;
      case "second":
        second = part.value;
        break;
    }
  }
  return `${year}-${month}-${day} ${hour}:${minute}:${second} UTC`;
}

export function renderLimitedResponse(req: Request) {
  const hostname = new URL(req.url).hostname;
  const ip = req.headers.get("cf-connecting-ip") ?? "";
  const ray = req.headers.get("cf-ray") ?? "";
  const date = formatDate(new Date());

  return `
	<!doctype html>
<!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US"> <![endif]-->
<!--[if IE 7]>    <html class="no-js ie7 oldie" lang="en-US"> <![endif]-->
<!--[if IE 8]>    <html class="no-js ie8 oldie" lang="en-US"> <![endif]-->
<!--[if gt IE 8]><!-->
<html class="no-js" lang="en-US">
    <!--<![endif]-->
    <head>
        <title>
            This website has been temporarily rate limited |
            ${hostname} | Cloudflare
        </title>
        <meta charset="UTF-8" />
        <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
        <meta http-equiv="X-UA-Compatible" content="IE=Edge" />
        <meta name="robots" content="noindex, nofollow" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <!--[if lt IE 9
            ]><link
                rel="stylesheet"
                id="cf_styles-ie-css"
                href="/cdn-cgi/styles/cf.errors.ie.css"
        /><![endif]-->
        <style>
            #cf-wrapper a,
            #cf-wrapper abbr,
            #cf-wrapper article,
            #cf-wrapper aside,
            #cf-wrapper b,
            #cf-wrapper big,
            #cf-wrapper blockquote,
            #cf-wrapper body,
            #cf-wrapper canvas,
            #cf-wrapper caption,
            #cf-wrapper center,
            #cf-wrapper cite,
            #cf-wrapper code,
            #cf-wrapper dd,
            #cf-wrapper del,
            #cf-wrapper details,
            #cf-wrapper dfn,
            #cf-wrapper div,
            #cf-wrapper dl,
            #cf-wrapper dt,
            #cf-wrapper em,
            #cf-wrapper embed,
            #cf-wrapper fieldset,
            #cf-wrapper figcaption,
            #cf-wrapper figure,
            #cf-wrapper footer,
            #cf-wrapper form,
            #cf-wrapper h1,
            #cf-wrapper h2,
            #cf-wrapper h3,
            #cf-wrapper h4,
            #cf-wrapper h5,
            #cf-wrapper h6,
            #cf-wrapper header,
            #cf-wrapper hgroup,
            #cf-wrapper html,
            #cf-wrapper i,
            #cf-wrapper iframe,
            #cf-wrapper img,
            #cf-wrapper label,
            #cf-wrapper legend,
            #cf-wrapper li,
            #cf-wrapper mark,
            #cf-wrapper menu,
            #cf-wrapper nav,
            #cf-wrapper object,
            #cf-wrapper ol,
            #cf-wrapper output,
            #cf-wrapper p,
            #cf-wrapper pre,
            #cf-wrapper s,
            #cf-wrapper samp,
            #cf-wrapper section,
            #cf-wrapper small,
            #cf-wrapper span,
            #cf-wrapper strike,
            #cf-wrapper strong,
            #cf-wrapper sub,
            #cf-wrapper summary,
            #cf-wrapper sup,
            #cf-wrapper table,
            #cf-wrapper tbody,
            #cf-wrapper td,
            #cf-wrapper tfoot,
            #cf-wrapper th,
            #cf-wrapper thead,
            #cf-wrapper tr,
            #cf-wrapper tt,
            #cf-wrapper u,
            #cf-wrapper ul {
                margin: 0;
                padding: 0;
                border: 0;
                font: inherit;
                font-size: 100%;
                text-decoration: none;
                vertical-align: baseline;
            }
            #cf-wrapper a img {
                border: none;
            }
            #cf-wrapper article,
            #cf-wrapper aside,
            #cf-wrapper details,
            #cf-wrapper figcaption,
            #cf-wrapper figure,
            #cf-wrapper footer,
            #cf-wrapper header,
            #cf-wrapper hgroup,
            #cf-wrapper menu,
            #cf-wrapper nav,
            #cf-wrapper section,
            #cf-wrapper summary {
                display: block;
            }
            #cf-wrapper .cf-columns:after,
            #cf-wrapper .cf-columns:before,
            #cf-wrapper .cf-section:after,
            #cf-wrapper .cf-section:before,
            #cf-wrapper .cf-wrapper:after,
            #cf-wrapper .cf-wrapper:before,
            #cf-wrapper .clearfix:after,
            #cf-wrapper .clearfix:before,
            #cf-wrapper section:after,
            #cf-wrapper section:before {
                content: " ";
                display: table;
            }
            #cf-wrapper .cf-columns:after,
            #cf-wrapper .cf-section:after,
            #cf-wrapper .cf-wrapper:after,
            #cf-wrapper .clearfix:after,
            #cf-wrapper section:after {
                clear: both;
            }
            #cf-wrapper {
                display: block;
                margin: 0;
                padding: 0;
                position: relative;
                text-align: left;
                width: 100%;
                z-index: 999999999;
                color: #404040 !important;
                font-family:
                    -apple-system,
                    BlinkMacSystemFont,
                    Segoe UI,
                    Roboto,
                    Oxygen,
                    Ubuntu,
                    Helvetica Neue,
                    Arial,
                    sans-serif !important;
                font-size: 15px !important;
                line-height: 1.5 !important;
                text-decoration: none !important;
                letter-spacing: normal;
                -webkit-tap-highlight-color: rgba(246, 139, 31, 0.3);
                -webkit-font-smoothing: antialiased;
            }
            #cf-wrapper .cf-section,
            #cf-wrapper section {
                background: 0 0;
                display: block;
                margin-bottom: 2em;
                margin-top: 2em;
            }
            #cf-wrapper .cf-wrapper {
                margin-left: auto;
                margin-right: auto;
                width: 90%;
            }
            #cf-wrapper .cf-columns {
                display: block;
                list-style: none;
                padding: 0;
                width: 100%;
            }
            #cf-wrapper .cf-columns img,
            #cf-wrapper .cf-columns input,
            #cf-wrapper .cf-columns object,
            #cf-wrapper .cf-columns select,
            #cf-wrapper .cf-columns textarea {
                max-width: 100%;
            }
            #cf-wrapper .cf-columns > .cf-column {
                float: left;
                padding-bottom: 45px;
                width: 100%;
                box-sizing: border-box;
            }
            @media screen and (min-width: 49.2em) {
                #cf-wrapper .cf-columns.cols-2 > .cf-column:nth-child(n + 3),
                #cf-wrapper .cf-columns.cols-3 > .cf-column:nth-child(n + 4),
                #cf-wrapper .cf-columns.cols-4 > .cf-column:nth-child(n + 3),
                #cf-wrapper .cf-columns.four > .cf-column:nth-child(n + 3),
                #cf-wrapper .cf-columns.three > .cf-column:nth-child(n + 4),
                #cf-wrapper .cf-columns.two > .cf-column:nth-child(n + 3) {
                    padding-top: 67.5px;
                }
                #cf-wrapper .cf-columns > .cf-column {
                    padding-bottom: 0;
                }
                #cf-wrapper .cf-columns.cols-2 > .cf-column,
                #cf-wrapper .cf-columns.cols-4 > .cf-column,
                #cf-wrapper .cf-columns.four > .cf-column,
                #cf-wrapper .cf-columns.two > .cf-column {
                    padding-left: 0;
                    padding-right: 22.5px;
                    width: 50%;
                }
                #cf-wrapper .cf-columns.cols-2 > .cf-column:nth-child(2n),
                #cf-wrapper .cf-columns.cols-4 > .cf-column:nth-child(2n),
                #cf-wrapper .cf-columns.four > .cf-column:nth-child(2n),
                #cf-wrapper .cf-columns.two > .cf-column:nth-child(2n) {
                    padding-left: 22.5px;
                    padding-right: 0;
                }
                #cf-wrapper .cf-columns.cols-2 > .cf-column:nth-child(odd),
                #cf-wrapper .cf-columns.cols-4 > .cf-column:nth-child(odd),
                #cf-wrapper .cf-columns.four > .cf-column:nth-child(odd),
                #cf-wrapper .cf-columns.two > .cf-column:nth-child(odd) {
                    clear: left;
                }
                #cf-wrapper .cf-columns.cols-3 > .cf-column,
                #cf-wrapper .cf-columns.three > .cf-column {
                    padding-left: 30px;
                    width: 33.3333333333333%;
                }
                #cf-wrapper .cf-columns.cols-3 > .cf-column:first-child,
                #cf-wrapper .cf-columns.cols-3 > .cf-column:nth-child(3n + 1),
                #cf-wrapper .cf-columns.three > .cf-column:first-child,
                #cf-wrapper .cf-columns.three > .cf-column:nth-child(3n + 1) {
                    clear: left;
                    padding-left: 0;
                    padding-right: 30px;
                }
                #cf-wrapper .cf-columns.cols-3 > .cf-column:nth-child(3n + 2),
                #cf-wrapper .cf-columns.three > .cf-column:nth-child(3n + 2) {
                    padding-left: 15px;
                    padding-right: 15px;
                }
                #cf-wrapper .cf-columns.cols-3 > .cf-column:nth-child(-n + 3),
                #cf-wrapper .cf-columns.three > .cf-column:nth-child(-n + 3) {
                    padding-top: 0;
                }
            }
            @media screen and (min-width: 66em) {
                #cf-wrapper .cf-columns > .cf-column {
                    padding-bottom: 0;
                }
                #cf-wrapper .cf-columns.cols-4 > .cf-column,
                #cf-wrapper .cf-columns.four > .cf-column {
                    padding-left: 33.75px;
                    width: 25%;
                }
                #cf-wrapper .cf-columns.cols-4 > .cf-column:nth-child(odd),
                #cf-wrapper .cf-columns.four > .cf-column:nth-child(odd) {
                    clear: none;
                }
                #cf-wrapper .cf-columns.cols-4 > .cf-column:first-child,
                #cf-wrapper .cf-columns.cols-4 > .cf-column:nth-child(4n + 1),
                #cf-wrapper .cf-columns.four > .cf-column:first-child,
                #cf-wrapper .cf-columns.four > .cf-column:nth-child(4n + 1) {
                    clear: left;
                    padding-left: 0;
                    padding-right: 33.75px;
                }
                #cf-wrapper .cf-columns.cols-4 > .cf-column:nth-child(4n + 2),
                #cf-wrapper .cf-columns.four > .cf-column:nth-child(4n + 2) {
                    padding-left: 11.25px;
                    padding-right: 22.5px;
                }
                #cf-wrapper .cf-columns.cols-4 > .cf-column:nth-child(4n + 3),
                #cf-wrapper .cf-columns.four > .cf-column:nth-child(4n + 3) {
                    padding-left: 22.5px;
                    padding-right: 11.25px;
                }
                #cf-wrapper .cf-columns.cols-4 > .cf-column:nth-child(n + 5),
                #cf-wrapper .cf-columns.four > .cf-column:nth-child(n + 5) {
                    padding-top: 67.5px;
                }
                #cf-wrapper .cf-columns.cols-4 > .cf-column:nth-child(-n + 4),
                #cf-wrapper .cf-columns.four > .cf-column:nth-child(-n + 4) {
                    padding-top: 0;
                }
            }
            #cf-wrapper a {
                background: 0 0;
                border: 0;
                color: #0051c3;
                outline: 0;
                text-decoration: none;
                -webkit-transition: all 0.15s ease;
                transition: all 0.15s ease;
            }
            #cf-wrapper a:hover {
                background: 0 0;
                border: 0;
                color: #f68b1f;
            }
            #cf-wrapper a:focus {
                background: 0 0;
                border: 0;
                color: #62a1d8;
                outline: 0;
            }
            #cf-wrapper a:active {
                background: 0 0;
                border: 0;
                color: #c16508;
                outline: 0;
            }
            #cf-wrapper h1,
            #cf-wrapper h2,
            #cf-wrapper h3,
            #cf-wrapper h4,
            #cf-wrapper h5,
            #cf-wrapper h6,
            #cf-wrapper p {
                color: #404040;
                margin: 0;
                padding: 0;
            }
            #cf-wrapper h1,
            #cf-wrapper h2,
            #cf-wrapper h3 {
                font-weight: 400;
            }
            #cf-wrapper h4,
            #cf-wrapper h5,
            #cf-wrapper h6,
            #cf-wrapper strong {
                font-weight: 600;
            }
            #cf-wrapper h1 {
                font-size: 36px;
                line-height: 1.2;
            }
            #cf-wrapper h2 {
                font-size: 30px;
                line-height: 1.3;
            }
            #cf-wrapper h3 {
                font-size: 25px;
                line-height: 1.3;
            }
            #cf-wrapper h4 {
                font-size: 20px;
                line-height: 1.3;
            }
            #cf-wrapper h5 {
                font-size: 15px;
            }
            #cf-wrapper h6 {
                font-size: 13px;
            }
            #cf-wrapper ol,
            #cf-wrapper ul {
                list-style: none;
                margin-left: 3em;
            }
            #cf-wrapper ul {
                list-style-type: disc;
            }
            #cf-wrapper ol {
                list-style-type: decimal;
            }
            #cf-wrapper em {
                font-style: italic;
            }
            #cf-wrapper .cf-subheadline {
                color: #595959;
                font-weight: 300;
            }
            #cf-wrapper .cf-text-error {
                color: #bd2426;
            }
            #cf-wrapper .cf-text-success {
                color: #9bca3e;
            }
            #cf-wrapper ol + h2,
            #cf-wrapper ol + h3,
            #cf-wrapper ol + h4,
            #cf-wrapper ol + h5,
            #cf-wrapper ol + h6,
            #cf-wrapper ol + p,
            #cf-wrapper p + dl,
            #cf-wrapper p + ol,
            #cf-wrapper p + p,
            #cf-wrapper p + table,
            #cf-wrapper p + ul,
            #cf-wrapper ul + h2,
            #cf-wrapper ul + h3,
            #cf-wrapper ul + h4,
            #cf-wrapper ul + h5,
            #cf-wrapper ul + h6,
            #cf-wrapper ul + p {
                margin-top: 1.5em;
            }
            #cf-wrapper h1 + p,
            #cf-wrapper p + h1,
            #cf-wrapper p + h2,
            #cf-wrapper p + h3,
            #cf-wrapper p + h4,
            #cf-wrapper p + h5,
            #cf-wrapper p + h6 {
                margin-top: 1.25em;
            }
            #cf-wrapper h1 + h2,
            #cf-wrapper h1 + h3,
            #cf-wrapper h2 + h3,
            #cf-wrapper h3 + h4,
            #cf-wrapper h4 + h5 {
                margin-top: 0.25em;
            }
            #cf-wrapper h2 + p {
                margin-top: 1em;
            }
            #cf-wrapper h1 + h4,
            #cf-wrapper h1 + h5,
            #cf-wrapper h1 + h6,
            #cf-wrapper h2 + h4,
            #cf-wrapper h2 + h5,
            #cf-wrapper h2 + h6,
            #cf-wrapper h3 + h5,
            #cf-wrapper h3 + h6,
            #cf-wrapper h3 + p,
            #cf-wrapper h4 + p,
            #cf-wrapper h5 + ol,
            #cf-wrapper h5 + p,
            #cf-wrapper h5 + ul {
                margin-top: 0.5em;
            }
            #cf-wrapper .cf-btn {
                background-color: transparent;
                border: 1px solid #999;
                color: #404040;
                font-size: 14px;
                font-weight: 400;
                line-height: 1.2;
                margin: 0;
                padding: 0.6em 1.33333em 0.53333em;
                -webkit-user-select: none;
                -moz-user-select: none;
                -ms-user-select: none;
                user-select: none;
                display: -moz-inline-stack;
                display: inline-block;
                vertical-align: middle;
                zoom: 1;
                border-radius: 2px;
                box-sizing: border-box;
                -webkit-transition: all 0.2s ease;
                transition: all 0.2s ease;
            }
            #cf-wrapper .cf-btn:hover {
                background-color: #bfbfbf;
                border: 1px solid #737373;
                color: #fff;
            }
            #cf-wrapper .cf-btn:focus {
                color: inherit;
                outline: 0;
                box-shadow: inset 0 0 4px rgba(0, 0, 0, 0.3);
            }
            #cf-wrapper .cf-btn.active,
            #cf-wrapper .cf-btn:active {
                background-color: #bfbfbf;
                border: 1px solid #404040;
                color: #272727;
            }
            #cf-wrapper .cf-btn::-moz-focus-inner {
                padding: 0;
                border: 0;
            }
            #cf-wrapper .cf-btn .cf-caret {
                border-top-color: currentColor;
                margin-left: 0.25em;
                margin-top: 0.18333em;
            }
            #cf-wrapper .cf-btn-primary {
                background-color: #2f7bbf;
                border: 1px solid transparent;
                color: #fff;
            }
            #cf-wrapper .cf-btn-primary:hover {
                background-color: #62a1d8;
                border: 1px solid #2f7bbf;
                color: #fff;
            }
            #cf-wrapper .cf-btn-primary.active,
            #cf-wrapper .cf-btn-primary:active,
            #cf-wrapper .cf-btn-primary:focus {
                background-color: #62a1d8;
                border: 1px solid #163959;
                color: #fff;
            }
            #cf-wrapper .cf-btn-danger,
            #cf-wrapper .cf-btn-error,
            #cf-wrapper .cf-btn-important {
                background-color: #bd2426;
                border-color: transparent;
                color: #fff;
            }
            #cf-wrapper .cf-btn-danger:hover,
            #cf-wrapper .cf-btn-error:hover,
            #cf-wrapper .cf-btn-important:hover {
                background-color: #de5052;
                border-color: #bd2426;
                color: #fff;
            }
            #cf-wrapper .cf-btn-danger.active,
            #cf-wrapper .cf-btn-danger:active,
            #cf-wrapper .cf-btn-danger:focus,
            #cf-wrapper .cf-btn-error.active,
            #cf-wrapper .cf-btn-error:active,
            #cf-wrapper .cf-btn-error:focus,
            #cf-wrapper .cf-btn-important.active,
            #cf-wrapper .cf-btn-important:active,
            #cf-wrapper .cf-btn-important:focus {
                background-color: #de5052;
                border-color: #521010;
                color: #fff;
            }
            #cf-wrapper .cf-btn-accept,
            #cf-wrapper .cf-btn-success {
                background-color: #9bca3e;
                border: 1px solid transparent;
                color: #fff;
            }
            #cf-wrapper .cf-btn-accept:hover,
            #cf-wrapper .cf-btn-success:hover {
                background-color: #bada7a;
                border: 1px solid #9bca3e;
                color: #fff;
            }
            #cf-wrapper .active.cf-btn-accept,
            #cf-wrapper .cf-btn-accept:active,
            #cf-wrapper .cf-btn-accept:focus,
            #cf-wrapper .cf-btn-success.active,
            #cf-wrapper .cf-btn-success:active,
            #cf-wrapper .cf-btn-success:focus {
                background-color: #bada7a;
                border: 1px solid #516b1d;
                color: #fff;
            }
            #cf-wrapper .cf-btn-accept {
                color: transparent;
                font-size: 0;
                height: 36.38px;
                overflow: hidden;
                position: relative;
                text-indent: 0;
                width: 36.38px;
                white-space: nowrap;
            }
            #cf-wrapper input,
            #cf-wrapper select,
            #cf-wrapper textarea {
                background: #fff !important;
                border: 1px solid #999 !important;
                color: #404040 !important;
                font-size: 0.86667em !important;
                line-height: 1.24 !important;
                margin: 0 0 1em !important;
                max-width: 100% !important;
                outline: 0 !important;
                padding: 0.45em 0.75em !important;
                vertical-align: middle !important;
                display: -moz-inline-stack;
                display: inline-block;
                zoom: 1;
                box-sizing: border-box;
                -webkit-transition: all 0.2s ease;
                transition: all 0.2s ease;
                border-radius: 2px;
            }
            #cf-wrapper input:hover,
            #cf-wrapper select:hover,
            #cf-wrapper textarea:hover {
                border-color: gray;
            }
            #cf-wrapper input:focus,
            #cf-wrapper select:focus,
            #cf-wrapper textarea:focus {
                border-color: #2f7bbf;
                outline: 0;
                box-shadow: 0 0 8px rgba(47, 123, 191, 0.5);
            }
            #cf-wrapper fieldset {
                width: 100%;
            }
            #cf-wrapper label {
                display: block;
                font-size: 13px;
                margin-bottom: 0.38333em;
            }
            #cf-wrapper .cf-form-stacked .select2-container,
            #cf-wrapper .cf-form-stacked input,
            #cf-wrapper .cf-form-stacked select,
            #cf-wrapper .cf-form-stacked textarea {
                display: block;
                width: 100%;
            }
            #cf-wrapper .cf-form-stacked input[type="button"],
            #cf-wrapper .cf-form-stacked input[type="checkbox"],
            #cf-wrapper .cf-form-stacked input[type="submit"] {
                display: -moz-inline-stack;
                display: inline-block;
                vertical-align: middle;
                zoom: 1;
                width: auto;
            }
            #cf-wrapper .cf-form-actions {
                text-align: right;
            }
            #cf-wrapper .cf-alert {
                background-color: #f9b169;
                border: 1px solid #904b06;
                color: #404040;
                font-size: 13px;
                padding: 7.5px 15px;
                position: relative;
                vertical-align: middle;
                border-radius: 2px;
            }
            #cf-wrapper .cf-alert:empty {
                display: none;
            }
            #cf-wrapper .cf-alert .cf-close {
                border: 1px solid transparent;
                color: inherit;
                font-size: 18.75px;
                line-height: 1;
                padding: 0;
                position: relative;
                right: -18.75px;
                top: 0;
            }
            #cf-wrapper .cf-alert .cf-close:hover {
                background-color: transparent;
                border-color: currentColor;
                color: inherit;
            }
            #cf-wrapper .cf-alert-danger,
            #cf-wrapper .cf-alert-error {
                background-color: #de5052;
                border-color: #521010;
                color: #fff;
            }
            #cf-wrapper .cf-alert-success {
                background-color: #bada7a;
                border-color: #516b1d;
                color: #516b1d;
            }
            #cf-wrapper .cf-alert-warning {
                background-color: #f9b169;
                border-color: #904b06;
                color: #404040;
            }
            #cf-wrapper .cf-alert-info {
                background-color: #62a1d8;
                border-color: #163959;
                color: #163959;
            }
            #cf-wrapper .cf-alert-nonessential {
                background-color: #ebebeb;
                border-color: #999;
                color: #404040;
            }
            #cf-wrapper .cf-icon-exclamation-sign {
                background: url(/cdn-cgi/images/icon-exclamation.png?1376755637)
                    50% no-repeat;
                height: 54px;
                width: 54px;
                display: -moz-inline-stack;
                display: inline-block;
                vertical-align: middle;
                zoom: 1;
            }
            #cf-wrapper h1 .cf-icon-exclamation-sign {
                margin-top: -10px;
            }
            #cf-wrapper #cf-error-banner {
                background-color: #fff;
                border-bottom: 3px solid #f68b1f;
                padding: 15px 15px 20px;
                position: relative;
                z-index: 999999999;
                box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
            }
            #cf-wrapper #cf-error-banner h4,
            #cf-wrapper #cf-error-banner p {
                display: -moz-inline-stack;
                display: inline-block;
                vertical-align: bottom;
                zoom: 1;
            }
            #cf-wrapper #cf-error-banner h4 {
                color: #2f7bbf;
                font-weight: 400;
                font-size: 20px;
                line-height: 1;
                vertical-align: baseline;
            }
            #cf-wrapper #cf-error-banner .cf-error-actions {
                margin-bottom: 10px;
                text-align: center;
                width: 100%;
            }
            #cf-wrapper #cf-error-banner .cf-error-actions a {
                display: -moz-inline-stack;
                display: inline-block;
                vertical-align: middle;
                zoom: 1;
            }
            #cf-wrapper #cf-error-banner .cf-error-actions a + a {
                margin-left: 10px;
            }
            #cf-wrapper #cf-error-banner .cf-error-actions .cf-btn-accept,
            #cf-wrapper #cf-error-banner .cf-error-actions .cf-btn-success {
                color: #fff;
            }
            #cf-wrapper #cf-error-banner .error-header-desc {
                text-align: left;
            }
            #cf-wrapper #cf-error-banner .cf-close {
                color: #999;
                cursor: pointer;
                display: inline-block;
                font-size: 34.5px;
                float: none;
                font-weight: 700;
                height: 22.5px;
                line-height: 0.6;
                overflow: hidden;
                position: absolute;
                right: 20px;
                top: 25px;
                text-indent: 200%;
                width: 22.5px;
            }
            #cf-wrapper #cf-error-banner .cf-close:hover {
                color: gray;
            }
            #cf-wrapper #cf-error-banner .cf-close:before {
                content: "\\00D7";
                left: 0;
                height: 100%;
                position: absolute;
                text-align: center;
                text-indent: 0;
                top: 0;
                width: 100%;
            }
            #cf-inline-error-wrapper {
                box-shadow: 0 2px 10px rgba(0, 0, 0, 0.5);
            }
            #cf-wrapper #cf-error-details {
                background: #fff;
            }
            #cf-wrapper #cf-error-details .cf-error-overview {
                padding: 25px 0 0;
            }
            #cf-wrapper #cf-error-details .cf-error-overview h1,
            #cf-wrapper #cf-error-details .cf-error-overview h2 {
                font-weight: 300;
            }
            #cf-wrapper #cf-error-details .cf-error-overview h2 {
                margin-top: 0;
            }
            #cf-wrapper #cf-error-details .cf-highlight {
                background: #ebebeb;
                overflow-x: hidden;
                padding: 30px 0;
                background-image: -webkit-gradient(
                    linear,
                    left top,
                    left bottom,
                    from(#dedede),
                    color-stop(3%, #ebebeb),
                    color-stop(97%, #ebebeb),
                    to(#dedede)
                );
                background-image: linear-gradient(
                    top,
                    #dedede,
                    #ebebeb 3%,
                    #ebebeb 97%,
                    #dedede
                );
            }
            #cf-wrapper #cf-error-details .cf-highlight h3 {
                color: #999;
                font-weight: 300;
            }
            #cf-wrapper #cf-error-details .cf-highlight .cf-column:last-child {
                padding-bottom: 0;
            }
            #cf-wrapper #cf-error-details .cf-highlight .cf-highlight-inverse {
                background-color: #fff;
                padding: 15px;
                border-radius: 2px;
            }
            #cf-wrapper #cf-error-details .cf-status-display h3 {
                margin-top: 0.5em;
            }
            #cf-wrapper #cf-error-details .cf-status-label {
                color: #9bca3e;
                font-size: 1.46667em;
            }
            #cf-wrapper #cf-error-details .cf-status-label,
            #cf-wrapper #cf-error-details .cf-status-name {
                display: inline;
            }
            #cf-wrapper #cf-error-details .cf-status-item {
                display: block;
                position: relative;
                text-align: left;
            }
            #cf-wrapper #cf-error-details .cf-status-item,
            #cf-wrapper #cf-error-details .cf-status-item.cf-column {
                padding-bottom: 1.5em;
            }
            #cf-wrapper #cf-error-details .cf-status-item.cf-error-source {
                display: block;
                text-align: center;
            }
            #cf-wrapper
                #cf-error-details
                .cf-status-item.cf-error-source:after {
                bottom: -60px;
                content: "";
                display: none;
                border-bottom: 18px solid #fff;
                border-left: 20px solid transparent;
                border-right: 20px solid transparent;
                height: 0;
                left: 50%;
                margin-left: -9px;
                position: absolute;
                right: 50%;
                width: 0;
            }
            #cf-wrapper #cf-error-details .cf-status-item + .cf-status-item {
                border-top: 1px solid #dedede;
                padding-top: 1.5em;
            }
            #cf-wrapper
                #cf-error-details
                .cf-status-item
                + .cf-status-item:before {
                background: url(/cdn-cgi/images/cf-icon-horizontal-arrow.png)
                    no-repeat;
                content: "";
                display: block;
                left: 0;
                position: absolute;
                top: 25.67px;
            }
            #cf-wrapper
                #cf-error-details
                .cf-error-source
                .cf-icon-error-container {
                height: 85px;
                margin-bottom: 2.5em;
            }
            #cf-wrapper #cf-error-details .cf-error-source .cf-status-label {
                color: #bd2426;
            }
            #cf-wrapper #cf-error-details .cf-error-source .cf-icon {
                display: block;
            }
            #cf-wrapper #cf-error-details .cf-error-source .cf-icon-status {
                bottom: -10px;
                left: 50%;
                top: auto;
                right: auto;
            }
            #cf-wrapper #cf-error-details .cf-error-source .cf-status-label,
            #cf-wrapper #cf-error-details .cf-error-source .cf-status-name {
                display: block;
            }
            #cf-wrapper #cf-error-details .cf-icon-error-container {
                height: auto;
                position: relative;
            }
            #cf-wrapper #cf-error-details .cf-icon-status {
                display: block;
                margin-left: -24px;
                position: absolute;
                top: 0;
                right: 0;
            }
            #cf-wrapper #cf-error-details .cf-icon {
                display: none;
                margin: 0 auto;
            }
            #cf-wrapper #cf-error-details .cf-status-desc {
                display: block;
                height: 22.5px;
                overflow: hidden;
                text-overflow: ellipsis;
                width: 100%;
                white-space: nowrap;
            }
            #cf-wrapper #cf-error-details .cf-status-desc:empty {
                display: none;
            }
            #cf-wrapper #cf-error-details .cf-error-footer {
                padding: 1.33333em 0;
                border-top: 1px solid #ebebeb;
                text-align: center;
            }
            #cf-wrapper #cf-error-details .cf-error-footer p {
                font-size: 13px;
            }
            #cf-wrapper #cf-error-details .cf-error-footer select {
                margin: 0 !important;
            }
            #cf-wrapper #cf-error-details .cf-footer-item {
                display: block;
                margin-bottom: 5px;
                text-align: left;
            }
            #cf-wrapper #cf-error-details .cf-footer-separator {
                display: none;
            }
            #cf-wrapper #cf-error-details .cf-captcha-info {
                margin-bottom: 10px;
                position: relative;
                text-align: center;
            }
            #cf-wrapper #cf-error-details .cf-captcha-image {
                height: 57px;
                width: 300px;
            }
            #cf-wrapper #cf-error-details .cf-captcha-actions {
                margin-top: 15px;
            }
            #cf-wrapper #cf-error-details .cf-captcha-actions a {
                font-size: 0;
                height: 36.38px;
                overflow: hidden;
                padding-left: 1.2em;
                padding-right: 1.2em;
                position: relative;
                text-indent: -9999px;
                width: 36.38px;
                white-space: nowrap;
            }
            #cf-wrapper
                #cf-error-details
                .cf-captcha-actions
                a.cf-icon-refresh
                span {
                background-position: 0 -787px;
            }
            #cf-wrapper
                #cf-error-details
                .cf-captcha-actions
                a.cf-icon-announce
                span {
                background-position: 0 -767px;
            }
            #cf-wrapper
                #cf-error-details
                .cf-captcha-actions
                a.cf-icon-question
                span {
                background-position: 0 -827px;
            }
            #cf-wrapper #cf-error-details .cf-screenshot-container {
                background: url(/cdn-cgi/images/browser-bar.png?1376755637)
                    no-repeat #fff;
                max-height: 400px;
                max-width: 100%;
                overflow: hidden;
                padding-top: 53px;
                width: 960px;
                border-radius: 5px 5px 0 0;
            }
            #cf-wrapper
                #cf-error-details
                .cf-screenshot-container
                .cf-no-screenshot {
                background: url(/cdn-cgi/images/cf-no-screenshot-warn.png)
                    no-repeat;
                display: block;
                height: 158px;
                left: 25%;
                margin-top: -79px;
                overflow: hidden;
                position: relative;
                top: 50%;
                width: 178px;
            }
            #cf-wrapper
                #cf-error-details
                .cf-captcha-container
                .cf-screenshot-container,
            #cf-wrapper
                #cf-error-details
                .cf-captcha-container
                .cf-screenshot-container
                img,
            #recaptcha-widget .cf-alert,
            #recaptcha-widget .recaptcha_only_if_audio,
            .cf-cookie-error {
                display: none;
            }
            #cf-wrapper
                #cf-error-details
                .cf-screenshot-container
                .cf-no-screenshot.error {
                background: url(/cdn-cgi/images/cf-no-screenshot-error.png)
                    no-repeat;
                height: 175px;
            }
            #cf-wrapper
                #cf-error-details
                .cf-screenshot-container.cf-screenshot-full
                .cf-no-screenshot {
                left: 50%;
                margin-left: -89px;
            }
            .cf-captcha-info iframe {
                max-width: 100%;
            }
            #cf-wrapper .cf-icon-ok {
                background: url(/cdn-cgi/images/cf-icon-ok.png) no-repeat;
                height: 48px;
                width: 48px;
            }
            #cf-wrapper .cf-icon-error {
                background: url(/cdn-cgi/images/cf-icon-error.png) no-repeat;
                height: 48px;
                width: 48px;
            }
            #cf-wrapper .cf-icon-browser {
                background: url(/cdn-cgi/images/cf-icon-browser.png) no-repeat;
                height: 80px;
                width: 100px;
            }
            #cf-wrapper .cf-icon-cloud {
                background: url(/cdn-cgi/images/cf-icon-cloud.png) no-repeat;
                height: 77px;
                width: 151px;
            }
            #cf-wrapper .cf-icon-server {
                background: url(/cdn-cgi/images/cf-icon-server.png) no-repeat;
                height: 75px;
                width: 95px;
            }
            #cf-wrapper .cf-caret {
                border: 0.33333em solid transparent;
                border-top-color: inherit;
                content: "";
                height: 0;
                width: 0;
                display: -moz-inline-stack;
                display: inline-block;
                vertical-align: middle;
                zoom: 1;
            }
            @media screen and (min-width: 49.2em) {
                #cf-wrapper #cf-error-details .cf-status-desc:empty,
                #cf-wrapper
                    #cf-error-details
                    .cf-status-item.cf-error-source:after,
                #cf-wrapper #cf-error-details .cf-status-item .cf-icon,
                #cf-wrapper #cf-error-details .cf-status-label,
                #cf-wrapper #cf-error-details .cf-status-name {
                    display: block;
                }
                #cf-wrapper .cf-wrapper {
                    width: 708px;
                }
                #cf-wrapper #cf-error-banner {
                    padding: 20px 20px 25px;
                }
                #cf-wrapper #cf-error-banner .cf-error-actions {
                    margin-bottom: 15px;
                }
                #cf-wrapper #cf-error-banner .cf-error-header-desc h4 {
                    margin-right: 0.5em;
                }
                #cf-wrapper #cf-error-details h1 {
                    font-size: 4em;
                }
                #cf-wrapper #cf-error-details .cf-error-overview {
                    padding-top: 2.33333em;
                }
                #cf-wrapper #cf-error-details .cf-highlight {
                    padding: 4em 0;
                }
                #cf-wrapper #cf-error-details .cf-status-item {
                    text-align: center;
                }
                #cf-wrapper #cf-error-details .cf-status-item,
                #cf-wrapper #cf-error-details .cf-status-item.cf-column {
                    padding-bottom: 0;
                }
                #cf-wrapper
                    #cf-error-details
                    .cf-status-item
                    + .cf-status-item {
                    border: 0;
                    padding-top: 0;
                }
                #cf-wrapper
                    #cf-error-details
                    .cf-status-item
                    + .cf-status-item:before {
                    background-position: 0 -544px;
                    height: 24.75px;
                    margin-left: -37.5px;
                    width: 75px;
                    background-size: 131.25px auto;
                }
                #cf-wrapper #cf-error-details .cf-icon-error-container {
                    height: 85px;
                    margin-bottom: 2.5em;
                }
                #cf-wrapper #cf-error-details .cf-icon-status {
                    bottom: -10px;
                    left: 50%;
                    top: auto;
                    right: auto;
                }
                #cf-wrapper #cf-error-details .cf-error-footer {
                    padding: 2.66667em 0;
                }
                #cf-wrapper #cf-error-details .cf-footer-item,
                #cf-wrapper #cf-error-details .cf-footer-separator {
                    display: -moz-inline-stack;
                    display: inline-block;
                    vertical-align: baseline;
                    zoom: 1;
                }
                #cf-wrapper #cf-error-details .cf-footer-separator {
                    padding: 0 0.25em;
                }
                #cf-wrapper
                    #cf-error-details
                    .cf-status-item.cloudflare-status:before {
                    margin-left: -50px;
                }
                #cf-wrapper
                    #cf-error-details
                    .cf-status-item.cloudflare-status
                    + .status-item:before {
                    margin-left: -25px;
                }
                #cf-wrapper #cf-error-details .cf-screenshot-container {
                    height: 400px;
                    margin-bottom: -4em;
                    max-width: none;
                }
                #cf-wrapper
                    #cf-error-details
                    .cf-captcha-container
                    .cf-screenshot-container,
                #cf-wrapper
                    #cf-error-details
                    .cf-captcha-container
                    .cf-screenshot-container
                    img {
                    display: block;
                }
            }
            @media screen and (min-width: 66em) {
                #cf-wrapper .cf-wrapper {
                    width: 960px;
                }
                #cf-wrapper #cf-error-banner .cf-close {
                    position: relative;
                    right: auto;
                    top: auto;
                }
                #cf-wrapper #cf-error-banner .cf-details {
                    white-space: nowrap;
                }
                #cf-wrapper #cf-error-banner .cf-details-link {
                    padding-right: 0.5em;
                }
                #cf-wrapper #cf-error-banner .cf-error-actions {
                    float: right;
                    margin-bottom: 0;
                    text-align: left;
                    width: auto;
                }
                #cf-wrapper
                    #cf-error-details
                    .cf-status-item
                    + .cf-status-item:before {
                    background-position: 0 -734px;
                    height: 33px;
                    margin-left: -50px;
                    width: 100px;
                    background-size: auto;
                }
                #cf-wrapper
                    #cf-error-details
                    .cf-status-item.cf-cloudflare-status:before {
                    margin-left: -66.67px;
                }
                #cf-wrapper
                    #cf-error-details
                    .cf-status-item.cf-cloudflare-status
                    + .cf-status-item:before {
                    margin-left: -37.5px;
                }
                #cf-wrapper #cf-error-details .cf-captcha-image {
                    float: left;
                }
                #cf-wrapper #cf-error-details .cf-captcha-actions {
                    position: absolute;
                    top: 0;
                    right: 0;
                }
            }
            .no-js #cf-wrapper .js-only {
                display: none;
            }
            #cf-wrapper #cf-error-details .heading-ray-id {
                font-family: monaco, courier, monospace;
                font-size: 15px;
                white-space: nowrap;
            }
            #cf-wrapper #cf-error-details .cf-footer-item.hidden,
            .cf-error-footer .hidden {
                display: none;
            }
            .cf-error-footer .cf-footer-ip-reveal-btn {
                -webkit-appearance: button;
                -moz-appearance: button;
                appearance: button;
                text-decoration: none;
                background: none;
                color: inherit;
                border: none;
                padding: 0;
                font: inherit;
                cursor: pointer;
                color: #0051c3;
                -webkit-transition: color 0.15s ease;
                transition: color 0.15s ease;
            }
            .cf-error-footer .cf-footer-ip-reveal-btn:hover {
                color: #ee730a;
            }
        </style>
        <style>
            body {
                margin: 0;
                padding: 0;
            }
        </style>

        <!--[if gte IE 10]><!-->
        <script>
            if (!navigator.cookieEnabled) {
                window.addEventListener("DOMContentLoaded", function () {
                    var cookieEl = document.getElementById("cookie-alert");
                    cookieEl.style.display = "block";
                });
            }
        </script>
        <!--<![endif]-->

        <style type="text/css">
            body {
                margin: 0;
                padding: 0;
            }

            #cf-wrapper {
                font-family:
                    -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
                    Helvetica, Arial, sans-serif, "Apple Color Emoji",
                    "Segoe UI Emoji", "Segoe UI Symbol" !important;
            }
            .cf-error-description {
                max-width: 600px;
            }
        </style>
    </head>
    <body>
        <div id="cf-wrapper">
            <div
                id="cookie-alert"
                class="cf-alert cf-alert-error cf-cookie-error"
                data-translate="enable_cookies"
            >
                Please enable cookies.
            </div>
            <div id="cf-error-details" class="cf-error-details-wrapper">
                <div class="cf-wrapper cf-header cf-error-overview">
                    <h1>
                        <span
                            class="cf-error-type"
                            data-translate="please check back later"
                            >Please check back later</span
                        >
                    </h1>
                    <h2 class="cf-subheadline">Error 1027</h2>
                </div>

                <div class="cf-section cf-wrapper">
                    <p>
                        <span
                            style="
                                width: 16px;
                                display: inline-block;
                                vertical-align: text-top;
                            "
                        >
                            <svg
                                fill="#b03340"
                                xmlns="http://www.w3.org/2000/svg"
                                viewBox="0 0 16 16"
                            >
                                <path
                                    d="M15.672,14.2,8.3,1.443a.352.352,0,0,0-.609,0L.328,14.2a.352.352,0,0,0,.3.527H15.368A.352.352,0,0,0,15.672,14.2ZM8.743,12.9a.221.221,0,0,1-.221.221H7.478a.221.221,0,0,1-.221-.221V11.86a.221.221,0,0,1,.221-.221H8.522a.221.221,0,0,1,.221.221Zm-.025-2.422H7.282L7.257,6.005H8.743Z"
                                />
                            </svg>
                        </span>
                        <strong>
                            This website has been temporarily rate limited
                        </strong>
                    </p>
                    <p class="cf-error-description">
                        You cannot access this site because the owner has
                        reached their plan limits. Check back later once traffic
                        has gone down.
                    </p>

                    <p class="cf-error-description">
                        If you are owner of this website, prevent this from
                        happening again by upgrading your plan on the
                        <a
                            href="https://dash.cloudflare.com/?account=workers/plans"
                            target="_blank"
                            >Cloudflare Workers dashboard</a
                        >.
                    </p>

                    <p>
                        <a
                            href="https://developers.cloudflare.com/workers/about/limits/#number-of-requests-limit"
                            target="_blank"
                            rel="noopener noreferrer"
                        >
                            Learn more about this issue →
                        </a>
                    </p>
                </div>

                <div class="cf-error-footer cf-wrapper">
                    <p>
                        <span class="cf-footer-item"
                            >Cloudflare Ray ID: ${ray}</span
                        >
                        <span class="cf-footer-separator">&bull;</span>
                        <span class="cf-footer-item"
                            >${date}</span
                        >
                        <span
                            id="cf-footer-item-ip"
                            class="cf-footer-item hidden"
                        >
                            <span class="cf-footer-separator">&bull;</span>
                            Your IP:
                            <button
                                type="button"
                                id="cf-footer-ip-reveal"
                                class="cf-footer-ip-reveal-btn"
                            >
                                Click to reveal
                            </button>
                            <span class="hidden" id="cf-footer-ip"
                                >${ip}</span
                            >
                        </span>
                        <span class="cf-footer-separator">&bull;</span>
                        <span class="cf-footer-item"
                            ><span>Runs on </span
                            ><a
                                rel="noopener noreferrer"
                                href="https://workers.cloudflare.com?utm_source=error_footer"
                                id="brand_link"
                                target="_blank"
                                >Cloudflare Workers</a
                            ></span
                        >
                    </p>
                    <script>
                        (function () {
                            function d() {
                                var b = a.getElementById("cf-footer-item-ip"),
                                    c = a.getElementById("cf-footer-ip-reveal");
                                b &&
                                    "classList" in b &&
                                    (b.classList.remove("hidden"),
                                    c.addEventListener("click", function () {
                                        c.classList.add("hidden");
                                        a.getElementById(
                                            "cf-footer-ip",
                                        ).classList.remove("hidden");
                                    }));
                            }
                            var a = document;
                            document.addEventListener &&
                                a.addEventListener("DOMContentLoaded", d);
                        })();
                    </script>
                </div>
                <!-- /.error-footer -->
            </div>
        </div>

        <script>
            window._cf_translation = {};
        </script>
    </body>
</html>`;
}
