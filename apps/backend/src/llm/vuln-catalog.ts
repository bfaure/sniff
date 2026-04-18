/**
 * Predefined vulnerability catalog for structured two-stage auto-analysis.
 *
 * Stage 1 (Classification): The triage LLM determines which vuln IDs from this
 * catalog are potentially applicable to the current exchange + recent context.
 *
 * Stage 2 (Specialist): For each matched vuln ID, a specialist prompt analyzes
 * the exchange specifically for that vulnerability type.
 */

export interface VulnCategory {
  id: string;
  name: string;
  /** Short description shown to the classifier so it knows what to look for */
  indicators: string;
  /** Full specialist prompt for deep analysis of this specific vuln type */
  specialistPrompt: string;
}

export const VULN_CATALOG: VulnCategory[] = [
  {
    id: 'sqli',
    name: 'SQL Injection',
    indicators: 'User input in query parameters, POST body, or path segments that could reach a SQL query. Look for: search fields, filter parameters, sort/order-by params, ID lookups, login forms. Also look for SQL error messages in responses (syntax errors, ODBC, MySQL, PostgreSQL, SQLite errors).',
    specialistPrompt: `You are a SQL injection specialist. Analyze this HTTP exchange for SQL injection vulnerabilities.

Check for:
- Parameters that appear to be used in database queries (id, name, search, filter, sort, order, where, query, etc.)
- Responses that include database error messages or stack traces
- Numeric or string parameters in URLs/bodies that could be injected
- Second-order injection vectors (stored input reflected later)
- Blind SQLi indicators: boolean-based (different responses for true/false conditions), time-based (response timing differences)
- UNION-based opportunities (response structure that could leak additional columns)
- Parameters where the application appears to construct queries dynamically

For each finding, provide:
- The exact parameter or injection point
- A concrete test payload (e.g., ' OR 1=1--, ' UNION SELECT NULL--)
- Whether it's likely error-based, blind boolean, blind time-based, or UNION-based
- The evidence from the request/response that suggests vulnerability`,
  },
  {
    id: 'xss',
    name: 'Cross-Site Scripting (XSS)',
    indicators: 'User input reflected in HTML responses. Look for: search terms in page content, URL parameters in page body, form inputs echoed back, user-generated content rendered without encoding, JSON responses rendered as HTML, Content-Type mismatches.',
    specialistPrompt: `You are an XSS specialist. Analyze this HTTP exchange for cross-site scripting vulnerabilities.

Check for:
- Reflected XSS: input from URL params, headers, or POST body reflected in the HTML response without encoding
- Stored XSS indicators: user-submitted content (comments, profiles, messages) rendered in responses
- DOM-based XSS: JavaScript code that reads from location, document.referrer, or other controllable sources
- Response Content-Type issues: JSON or plaintext served as text/html
- Missing or weak Content-Security-Policy headers
- Input that passes through but is partially filtered (filter bypass opportunities)
- Contexts: HTML body, HTML attributes, JavaScript strings, CSS, URL attributes (href/src)

For each finding, provide:
- The exact reflection point and context (HTML body, attribute, JS, etc.)
- A context-appropriate test payload
- Whether encoding is present and if it can be bypassed
- The evidence showing the reflection`,
  },
  {
    id: 'idor',
    name: 'IDOR / Broken Object-Level Authorization',
    indicators: 'Sequential or guessable IDs in URLs or request bodies used to access resources. Look for: numeric IDs in paths (/users/123, /orders/456), UUIDs that could be enumerated, API endpoints that return user-specific data, different responses based on ID values, missing authorization checks on resource access.',
    specialistPrompt: `You are an IDOR/authorization specialist. Analyze this HTTP exchange for broken object-level authorization.

Check for:
- Sequential numeric IDs in URL paths or query parameters that reference user-owned resources
- Resource identifiers (IDs, UUIDs, slugs) that could be modified to access other users' data
- API endpoints that return sensitive data based on an ID without apparent authorization verification
- Endpoints where changing the resource ID in a request could expose other users' data
- Batch/bulk endpoints that might return data across authorization boundaries
- GraphQL queries with user-controllable object references
- Responses that include data ownership indicators (user_id, owner, created_by) suggesting the resource belongs to a specific user

For each finding, provide:
- The exact parameter/path segment containing the object reference
- What resource type is being accessed
- Evidence that authorization may be insufficient (e.g., no auth header required, response contains user-specific data)
- A concrete test: try ID ± 1, or suggest testing with a different user session`,
  },
  {
    id: 'auth-bypass',
    name: 'Authentication / Authorization Bypass',
    indicators: 'Authentication endpoints (login, register, password reset, OTP, MFA), token handling (JWT, session cookies, API keys), privilege escalation vectors. Look for: auth tokens in responses, role/permission fields in requests, admin endpoints accessible without admin tokens, weak token generation.',
    specialistPrompt: `You are an authentication/authorization specialist. Analyze this HTTP exchange for auth bypass vulnerabilities.

Check for:
- Weak or predictable session tokens/JWTs (decode JWT and examine claims, algorithm, expiry)
- Missing authentication on sensitive endpoints
- Role or privilege fields in request bodies that could be tampered (role=admin, is_admin=true)
- Password reset flows with weak tokens or missing rate limiting
- Token leakage in URLs, referrer headers, or error messages
- Missing CSRF protection on state-changing endpoints
- API keys or credentials in client-side code or responses
- Endpoints that accept both authenticated and unauthenticated requests with different behavior
- OAuth/OIDC misconfigurations (open redirects in redirect_uri, token in URL fragment)

For each finding, provide:
- The specific auth mechanism and its weakness
- Concrete steps to exploit (e.g., modify JWT claim, replay token, remove auth header)
- Evidence from the exchange`,
  },
  {
    id: 'ssrf',
    name: 'Server-Side Request Forgery (SSRF)',
    indicators: 'Parameters that accept URLs, hostnames, IPs, or file paths. Look for: URL parameters (url=, link=, redirect=, callback=, webhook=, proxy=, fetch=), image/file fetch endpoints, PDF generators, webhook configurations, integration endpoints.',
    specialistPrompt: `You are an SSRF specialist. Analyze this HTTP exchange for server-side request forgery vulnerabilities.

Check for:
- Parameters that accept URLs or hostnames (url, link, src, dest, redirect, callback, webhook, proxy, fetch, load, page, uri, path)
- File inclusion parameters (file, template, include, page)
- Endpoints that fetch or render external content (PDF generators, image resizers, link previewers, webhook endpoints)
- Internal IP addresses or localhost references in responses (indicating server-side fetching)
- Cloud metadata endpoint access potential (169.254.169.254, metadata.google.internal)
- DNS rebinding opportunities
- Partial SSRF via URL parsing differences

For each finding, provide:
- The exact parameter that accepts a URL/path
- Test payloads for internal scanning (http://127.0.0.1, http://169.254.169.254/latest/meta-data/)
- Whether the response content is returned (full SSRF) or just status-based (blind SSRF)`,
  },
  {
    id: 'cmdi',
    name: 'Command / Code Injection',
    indicators: 'Parameters that could be passed to system commands or code evaluators. Look for: filename parameters, ping/traceroute tools, DNS lookup tools, file conversion endpoints, template parameters, eval-like functionality, parameters with shell metacharacters in responses.',
    specialistPrompt: `You are a command/code injection specialist. Analyze this HTTP exchange for injection vulnerabilities.

Check for:
- OS command injection: parameters passed to system commands (filename, host, ip, cmd, command, exec, ping, path)
- Template injection (SSTI): user input rendered through server-side template engines (Jinja2, Freemarker, Twig, ERB, etc.)
- Expression language injection (Spring EL, OGNL, MVEL)
- LDAP injection in directory search parameters
- XPath injection in XML query parameters
- Code injection in eval-like endpoints

For each finding, provide:
- The specific parameter and likely injection context (OS command, template, expression)
- Context-appropriate payloads (e.g., ;id, |whoami, {{7*7}}, \${7*7})
- Evidence from the response suggesting the parameter reaches a dangerous sink`,
  },
  {
    id: 'path-traversal',
    name: 'Path Traversal / LFI / RFI',
    indicators: 'File path parameters, file download/upload endpoints, include parameters. Look for: file=, path=, template=, page=, include=, doc=, download endpoints, static file serving with user-controlled paths.',
    specialistPrompt: `You are a path traversal specialist. Analyze this HTTP exchange for file inclusion vulnerabilities.

Check for:
- Local File Inclusion (LFI): parameters controlling file paths (file, path, page, template, include, doc, lang, dir)
- Directory traversal sequences that might work: ../, ..\\, %2e%2e%2f, %252e%252e%252f
- Remote File Inclusion (RFI): parameters that accept URLs for file loading
- Null byte injection to truncate file extensions
- File upload + LFI chains
- Static file endpoints that don't properly restrict to webroot
- Responses that leak filesystem information (absolute paths, directory listings)

For each finding, provide:
- The exact parameter and current value
- Traversal payloads to test (../../../etc/passwd, ..\\..\\windows\\win.ini)
- Evidence of path handling in the response`,
  },
  {
    id: 'info-disclosure',
    name: 'Sensitive Data Exposure / Information Disclosure',
    indicators: 'Sensitive data in responses: API keys, internal IPs, stack traces, debug info, PII, database info, server version headers, verbose error messages, directory listings, .env or config file exposure, source code in responses.',
    specialistPrompt: `You are an information disclosure specialist. Analyze this HTTP exchange for sensitive data exposure.

Check for:
- API keys, tokens, passwords, or credentials in responses (including JavaScript files and HTML comments)
- Internal IP addresses, hostnames, or infrastructure details
- Stack traces, debug output, or verbose error messages
- Server version headers revealing exact software versions with known CVEs
- Database connection strings or query details in errors
- PII exposure (emails, phone numbers, SSNs, addresses) beyond what's expected
- Source code or configuration files exposed
- Directory listings or backup files
- CORS misconfigurations allowing credential theft
- Overly permissive response data (returning fields the user shouldn't see)

For each finding, provide:
- The exact sensitive data found and where it appears
- The risk: what an attacker could do with this information
- Whether this is directly exploitable or aids further attacks`,
  },
  {
    id: 'insecure-headers',
    name: 'Missing Security Headers / Cookie Issues',
    indicators: 'Missing or weak security headers in responses, insecure cookie attributes. Look for: missing Content-Security-Policy, X-Frame-Options, Strict-Transport-Security, X-Content-Type-Options. Cookies without Secure, HttpOnly, SameSite flags. CORS with wildcard or reflected origins.',
    specialistPrompt: `You are a security headers specialist. Analyze this HTTP exchange for missing or misconfigured security headers.

Check for:
- Missing Content-Security-Policy (or overly permissive: unsafe-inline, unsafe-eval, wildcard sources)
- Missing X-Frame-Options or frame-ancestors CSP (clickjacking risk)
- Missing Strict-Transport-Security (HSTS) or weak max-age
- Missing X-Content-Type-Options: nosniff
- CORS misconfiguration: Access-Control-Allow-Origin: * with credentials, or reflected Origin
- Cookies missing Secure flag (sent over HTTP)
- Cookies missing HttpOnly flag (accessible to JavaScript)
- Cookies missing SameSite attribute (CSRF risk)
- Cache-Control allowing sensitive response caching
- Referrer-Policy exposing URLs to third parties

For each finding, provide:
- The specific header that is missing or misconfigured
- The current value (if set) and what it should be
- The concrete attack this enables`,
  },
  {
    id: 'mass-assignment',
    name: 'Mass Assignment / Parameter Tampering',
    indicators: 'API endpoints accepting JSON/form bodies for creating or updating resources. Look for: POST/PUT/PATCH endpoints with JSON bodies, responses that include more fields than were submitted (indicating additional settable fields), role/status/permission fields in response objects.',
    specialistPrompt: `You are a mass assignment specialist. Analyze this HTTP exchange for parameter tampering vulnerabilities.

Check for:
- JSON request bodies where additional fields could be injected (role, is_admin, permissions, verified, balance, price, discount)
- Response objects that include sensitive fields not in the request (suggesting the model accepts them)
- PUT/PATCH endpoints that might accept partial updates including privileged fields
- Price/quantity/amount fields in e-commerce flows that could be tampered
- Status fields (active, approved, verified) that users shouldn't control
- Nested objects that might contain exploitable properties

For each finding, provide:
- The endpoint and current request body
- Specific fields to add/modify in the request
- Evidence from the response suggesting the model is wider than the intended input`,
  },
  {
    id: 'race-condition',
    name: 'Race Condition / TOCTOU',
    indicators: 'Endpoints performing non-atomic operations: balance transfers, coupon redemption, vote/like endpoints, resource claiming, inventory management, one-time operations. Look for: financial transactions, limited-use tokens, state-changing operations without apparent locking.',
    specialistPrompt: `You are a race condition specialist. Analyze this HTTP exchange for time-of-check-to-time-of-use vulnerabilities.

Check for:
- Financial operations (transfers, payments, withdrawals) that could be sent concurrently
- Coupon/promo code redemption that might not be atomic
- Vote/like/follow endpoints without idempotency
- Resource claiming (reservation, booking) without locking
- One-time-use tokens (password reset, email verification) that might be reusable in a race window
- File upload + processing pipelines with race windows
- Check-then-act patterns visible in the API design

For each finding, provide:
- The endpoint and operation at risk
- How to exploit: number of concurrent requests, timing considerations
- The potential impact (double-spend, duplicate actions, bypassed limits)`,
  },
  {
    id: 'open-redirect',
    name: 'Open Redirect',
    indicators: 'URL redirect parameters, login flows with return URLs, OAuth callback URLs. Look for: redirect=, return=, next=, url=, goto=, continue=, dest=, destination=, redir=, return_to= parameters, 3xx responses with Location header containing user input.',
    specialistPrompt: `You are an open redirect specialist. Analyze this HTTP exchange for open redirect vulnerabilities.

Check for:
- Parameters controlling redirect destinations (redirect, return, next, url, goto, continue, dest, redir, return_to, callback)
- 3xx responses where the Location header includes user-controllable input
- JavaScript-based redirects using window.location with user input
- Meta refresh tags with controllable URLs
- OAuth redirect_uri parameters that accept arbitrary domains
- Protocol-relative URLs (//evil.com) or domain confusion (@evil.com)
- Filter bypass techniques: //evil.com, /\\evil.com, /%09/evil.com

For each finding, provide:
- The exact parameter and current value
- Bypass payloads if filtering is detected
- Chaining potential (phishing, token theft via referrer, OAuth token interception)`,
  },
  {
    id: 'deserialization',
    name: 'Insecure Deserialization',
    indicators: 'Serialized objects in requests or responses. Look for: Java serialized objects (rO0AB, aced0005), PHP serialized data (O:, a:, s:), .NET ViewState, Python pickle, base64-encoded blobs in cookies or parameters, Content-Type: application/x-java-serialized-object.',
    specialistPrompt: `You are a deserialization specialist. Analyze this HTTP exchange for insecure deserialization.

Check for:
- Java serialized objects in request parameters, cookies, or headers (magic bytes: rO0AB or hex aced0005)
- PHP serialized data (patterns like O:4:"User", a:3:{, s:5:"admin")
- .NET ViewState without MAC validation (__VIEWSTATE parameter)
- Python pickle data in cookies or API parameters
- YAML deserialization in API endpoints accepting YAML content
- Custom serialization formats that might be tampered with
- Base64-encoded blobs that decode to structured data

For each finding, provide:
- The location and format of the serialized data
- Decoded/analyzed contents
- Whether the format is known to allow code execution (Java gadget chains, PHP POP chains, etc.)
- A test payload appropriate to the serialization format`,
  },
  {
    id: 'business-logic',
    name: 'Business Logic Flaws',
    indicators: 'Multi-step workflows, pricing/discount logic, access control transitions, state machines. Look for: checkout flows, approval processes, role changes, feature flag toggling, subscription management, referral systems, anything where the order or combination of operations matters.',
    specialistPrompt: `You are a business logic specialist. Analyze this HTTP exchange (in the context of recent traffic) for logic flaws.

Check for:
- Workflow bypass: skipping steps in multi-step processes (checkout, verification, approval)
- Price manipulation: modifying quantities, amounts, or discount codes client-side
- Negative quantity/amount attacks in financial operations
- Feature access without proper subscription/license validation
- Rate limit bypass on sensitive operations
- Inconsistent state transitions (e.g., cancelling then completing an order)
- Referral or rewards system abuse
- Time-based logic flaws (expired promotions still accepted)
- Endpoint access that violates the intended user journey

For each finding, provide:
- The business logic flow and the flaw
- Steps to exploit the logic error
- Evidence from the traffic pattern that reveals the vulnerability`,
  },
];

/** Quick lookup by ID */
export const VULN_BY_ID = new Map(VULN_CATALOG.map((v) => [v.id, v]));

/**
 * Build the classifier prompt that enumerates all vulnerability categories
 * for the triage LLM to classify against.
 */
export function buildClassifierPrompt(): string {
  const catalogText = VULN_CATALOG.map(
    (v) => `- **${v.id}** (${v.name}): ${v.indicators}`,
  ).join('\n');

  return `You are a security triage classifier inside an interception proxy. You analyze HTTP exchanges to determine which specific vulnerability categories warrant further investigation.

You have:
1. **Session observations** — patterns from earlier requests
2. **Prior findings** — already-reported vulnerabilities (DO NOT flag these categories again for the same pattern)
3. **Recent traffic** — context from nearby requests for cross-request pattern detection
4. **The current exchange** — the new HTTP request/response to classify

Your job: determine which vulnerability categories from the catalog below could POTENTIALLY apply to this exchange. Be selective — only flag categories where you see concrete indicators, not theoretical possibilities. Consider cross-request patterns when relevant (e.g., sequential IDs across requests suggest IDOR).

=== VULNERABILITY CATALOG ===
${catalogText}

Respond ONLY with valid JSON (no markdown fences):
{
  "matches": [
    {
      "vulnId": "the category ID from the catalog",
      "reason": "one sentence explaining WHY this exchange might be vulnerable to this — cite the specific parameter, header, or pattern you noticed"
    }
  ],
  "observations": "Updated observations about this target application (max 500 chars). Include: auth mechanisms seen, interesting parameters, endpoint patterns, ID formats, tech stack, session handling. Only update if you learned something new — otherwise return the existing observations unchanged.",
  "escalate": false
}

Set "escalate": true ONLY if you see a potential multi-step attack chain or business logic issue that spans multiple requests and requires holistic analysis beyond individual vulnerability categories.

If nothing looks interesting, return: {"matches": [], "observations": "...existing or updated observations...", "escalate": false}

Be selective — only match categories where you see real indicators in the traffic.`;
}

/**
 * Build a specialist prompt for a specific vulnerability type.
 */
export function buildSpecialistUserPrompt(
  vuln: VulnCategory,
  classifierReason: string,
  exchangeText: string,
  priorFindingsText: string,
  fpText: string,
): string {
  const sections = [
    `The triage classifier flagged this exchange as potentially vulnerable to **${vuln.name}** because: ${classifierReason}`,
    priorFindingsText ? `=== PRIOR ${vuln.name.toUpperCase()} FINDINGS (do not re-report) ===\n${priorFindingsText}` : '',
    fpText ? `=== FALSE POSITIVES (do not report these patterns) ===\n${fpText}` : '',
    `=== EXCHANGE TO ANALYZE ===\n${exchangeText}`,
  ].filter(Boolean);

  return sections.join('\n\n');
}

export const SPECIALIST_SYSTEM_SUFFIX = `

Severity calibration — be precise, do not over-rate:
- critical: Directly exploitable, no user interaction, full compromise (RCE, auth bypass, pre-auth SQLi)
- high: Directly exploitable with significant impact (stored XSS, IDOR, SSRF to internal)
- medium: Exploitable but requires conditions or chaining (reflected XSS, CSRF)
- low: Minor issues with limited impact (verbose errors, insecure cookie flags on non-session cookies)
- info: Defense-in-depth, best practices, hardening (missing headers like CSP/HSTS/X-Frame-Options, server version disclosure)

Missing security headers are ALWAYS "info" severity — they are hardening measures, not directly exploitable.

Respond ONLY with valid JSON (no markdown fences):
{
  "findings": [
    {
      "severity": "critical|high|medium|low|info",
      "cvss": 7.5,
      "cvssVector": "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N",
      "title": "short title (under 60 chars)",
      "detail": "detailed explanation with the specific parameter, evidence, and a concrete test payload or curl command",
      "evidence": "the exact part of the request/response that indicates the issue",
      "suggestedTest": "a concrete curl command or payload to confirm this vulnerability"
    }
  ]
}

If after careful analysis you determine this is NOT actually vulnerable, return: {"findings": []}
Only report findings where you have concrete evidence — do not speculate.`;
