import type { AnalysisType, LLMMessage } from '@sniff/shared';

interface ExchangeContext {
  method: string;
  url: string;
  requestHeaders: Record<string, string>;
  requestBody: string | null;
  statusCode: number | null;
  responseHeaders: Record<string, string> | null;
  responseBody: string | null;
}

function formatExchange(ex: ExchangeContext): string {
  const parts: string[] = [];

  parts.push(`=== REQUEST ===`);
  parts.push(`${ex.method} ${ex.url}`);
  for (const [k, v] of Object.entries(ex.requestHeaders)) {
    parts.push(`${k}: ${v}`);
  }
  if (ex.requestBody) {
    parts.push('');
    const reqBody = ex.requestBody.length > 8000
      ? ex.requestBody.slice(0, 8000) + '\n... [truncated, ' + formatSize(ex.requestBody.length) + ' total]'
      : ex.requestBody;
    parts.push(reqBody);
  }

  if (ex.statusCode != null) {
    parts.push('');
    parts.push(`=== RESPONSE (${ex.statusCode}) ===`);
    if (ex.responseHeaders) {
      for (const [k, v] of Object.entries(ex.responseHeaders)) {
        parts.push(`${k}: ${v}`);
      }
    }
    if (ex.responseBody) {
      parts.push('');
      const body = ex.responseBody.length > 8000
        ? ex.responseBody.slice(0, 8000) + '\n... [truncated, ' + formatSize(ex.responseBody.length) + ' total]'
        : ex.responseBody;
      parts.push(body);
    }
  }

  return parts.join('\n');
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

const SYSTEM_BASE = `You are an expert penetration testing assistant integrated into an interception proxy tool (similar to Burp Suite). You analyze HTTP traffic for security vulnerabilities and help testers find and exploit weaknesses. Be direct, technical, and actionable. When suggesting attacks, include concrete payloads and steps.`;

export function buildMessages(type: AnalysisType, exchange: ExchangeContext, userMessage?: string, projectContext?: string): LLMMessage[] {
  const exchangeText = formatExchange(exchange);
  const projectBlock = projectContext ? `\n\n=== PROJECT CONTEXT ===\n${projectContext}\n` : '';

  switch (type) {
    case 'vuln-scan':
      return [
        { role: 'system', content: SYSTEM_BASE + projectBlock },
        {
          role: 'user',
          content: `Analyze this HTTP exchange for security vulnerabilities. Check for:
- SQL injection (error-based, blind, time-based)
- Cross-site scripting (reflected, stored, DOM-based)
- Insecure Direct Object References (IDOR)
- Authentication/authorization issues
- Information disclosure (stack traces, verbose errors, internal IPs)
- Missing security headers
- Insecure cookies
- Server-side request forgery (SSRF)
- Open redirects
- Command injection

Severity calibration — be precise, do not over-rate:
- critical: Directly exploitable with no user interaction, full system compromise (e.g. RCE, auth bypass, pre-auth SQLi with data exfil)
- high: Directly exploitable vulnerability with significant impact (e.g. stored XSS, IDOR accessing other users' data, SSRF to internal services)
- medium: Exploitable but requires specific conditions or chaining (e.g. reflected XSS needing user click, CSRF on state-changing action)
- low: Minor issues with limited direct impact (e.g. verbose error messages exposing stack traces, insecure cookie flags on non-session cookies)
- info: Defense-in-depth observations, best practice deviations, hardening recommendations (e.g. missing security headers like CSP/HSTS/X-Frame-Options, missing X-Content-Type-Options, informational disclosures like server version)

Missing security headers (CSP, HSTS, X-Frame-Options, X-Content-Type-Options, etc.) are ALWAYS "info" or at most "low" severity — they are hardening measures, not directly exploitable vulnerabilities.

For each finding, respond in this JSON format:
\`\`\`json
{
  "findings": [
    {
      "type": "SQLi|XSS|IDOR|AuthN|InfoDisclosure|MissingHeaders|InsecureCookies|SSRF|OpenRedirect|CmdInjection|Other",
      "severity": "critical|high|medium|low|info",
      "cvss": 7.5,
      "cvssVector": "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N",
      "evidence": "the specific part of the request/response that indicates the issue",
      "explanation": "why this is a vulnerability and its potential impact",
      "suggestedTest": "a concrete curl command or payload to confirm/exploit this"
    }
  ],
  "summary": "brief overall assessment"
}
\`\`\`

HTTP Exchange:
${exchangeText}`,
        },
      ];

    case 'explain':
      return [
        { role: 'system', content: SYSTEM_BASE },
        {
          role: 'user',
          content: `Explain what this HTTP exchange does in plain language. Cover:
1. What the client is requesting and why
2. What the server is returning
3. Any authentication or session mechanisms used
4. Any notable headers or patterns
5. Potential security implications

Be concise but thorough.

HTTP Exchange:
${exchangeText}`,
        },
      ];

    case 'suggest-followup':
      return [
        { role: 'system', content: SYSTEM_BASE },
        {
          role: 'user',
          content: `Based on this HTTP exchange, suggest follow-up requests a pentester should try. For each suggestion, provide:

1. A brief description of what you're testing
2. The complete HTTP request (method, URL, headers, body) that can be directly sent

Format each suggestion as:
\`\`\`json
{
  "suggestions": [
    {
      "description": "what this tests",
      "method": "GET|POST|PUT|DELETE|etc",
      "url": "full URL",
      "headers": {"key": "value"},
      "body": "request body or null"
    }
  ]
}
\`\`\`

Focus on: parameter tampering, authentication bypasses, privilege escalation, injection points, and boundary testing.

HTTP Exchange:
${exchangeText}`,
        },
      ];

    case 'generate-payloads':
      return [
        { role: 'system', content: SYSTEM_BASE },
        {
          role: 'user',
          content: `Generate fuzzing payloads for the injection points in this HTTP exchange. Identify all user-controllable parameters (URL params, headers, body fields) and generate targeted payloads for each.

For each injection point, provide payloads for:
- SQL injection
- XSS
- Command injection
- Path traversal
- SSTI (if applicable)

Format as:
\`\`\`json
{
  "injectionPoints": [
    {
      "location": "parameter name/location",
      "originalValue": "the original value",
      "payloads": ["payload1", "payload2", ...]
    }
  ]
}
\`\`\`

HTTP Exchange:
${exchangeText}`,
        },
      ];

    case 'pentest-pathway':
      return [
        { role: 'system', content: SYSTEM_BASE + projectBlock },
        {
          role: 'user',
          content: `Based on this HTTP exchange and the application behavior it reveals, suggest a prioritized penetration testing pathway. Consider:

1. What type of application/API is this?
2. What attack surface is exposed?
3. What are the highest-value targets?
4. What sequence of tests would be most efficient?

Provide a numbered, prioritized list of attack vectors with concrete steps for each.

HTTP Exchange:
${exchangeText}`,
        },
      ];

    case 'chat':
      return [
        { role: 'system', content: `${SYSTEM_BASE}${projectBlock}

You have access to the following HTTP exchange as context:

${exchangeText}

You can suggest ACTIONS the user can take. When you want to suggest a concrete action, include a JSON action block in your response using this format:

\`\`\`action
{"type": "send-to-replay", "method": "GET", "url": "...", "headers": {...}, "body": null}
\`\`\`

\`\`\`action
{"type": "create-fuzzer-job", "name": "...", "attackType": "single|parallel|paired|cartesian", "templateReq": {"method": "...", "url": "...", "headers": {...}, "body": "..."}, "payloadPositions": ["param1"], "payloads": [["payload1", "payload2", ...]]}
\`\`\`

Use § markers in the templateReq to mark injection points, e.g. url: "http://example.com/api/users/§user_id§"
Only include action blocks when the user asks you to set something up or when it's clearly helpful. Otherwise just respond in plain text.` },
        { role: 'user', content: userMessage || 'Analyze this request.' },
      ];

    default:
      return [
        { role: 'system', content: SYSTEM_BASE },
        { role: 'user', content: `Analyze this HTTP exchange:\n\n${exchangeText}` },
      ];
  }
}

/**
 * Build messages for a standalone project-level chat (not tied to a single exchange).
 * The AI has full project context and can discuss findings, scope, strategy, etc.
 */
export function buildProjectChatMessages(
  projectContext: string,
  userMessage: string,
  referencedExchanges?: Array<{ method: string; url: string; statusCode: number | null; requestHeaders: string; responseHeaders: string | null }>,
): LLMMessage[] {
  let exchangeBlock = '';
  if (referencedExchanges && referencedExchanges.length > 0) {
    const summaries = referencedExchanges.map((ex, i) => {
      const reqH = JSON.parse(ex.requestHeaders);
      const authHeaders = ['authorization', 'cookie', 'x-api-key'].filter((h) => reqH[h]).map((h) => `${h}: ${reqH[h]}`).join(', ');
      return `  ${i + 1}. ${ex.method} ${ex.url} → ${ex.statusCode || '?'}${authHeaders ? ` [${authHeaders}]` : ''}`;
    }).join('\n');
    exchangeBlock = `\n\n=== REFERENCED EXCHANGES ===\n${summaries}`;
  }

  return [
    {
      role: 'system',
      content: `${SYSTEM_BASE}

You are in a project-level chat mode. You have access to the tester's full project context including scope rules, discovered endpoints, session observations, and recent findings. Use this to provide strategic guidance, discuss attack approaches, explain findings, and help plan the pentest.

${projectContext}${exchangeBlock}

You can suggest ACTIONS:
\`\`\`action
{"type": "send-to-replay", "method": "GET", "url": "...", "headers": {...}, "body": null}
\`\`\`
\`\`\`action
{"type": "create-fuzzer-job", "name": "...", "attackType": "single", "templateReq": {"method": "...", "url": "...", "headers": {...}, "body": "..."}, "payloadPositions": ["param1"], "payloads": [["payload1", "payload2"]]}
\`\`\`

Use § markers for injection points in templateReq. Only include actions when helpful.`,
    },
    { role: 'user', content: userMessage },
  ];
}

/**
 * Build messages for an interactive Replay "guided vulnerability test" session.
 * The model acts as a pentest mentor walking the tester through probing a single
 * request/response for a specific vulnerability class. It should propose ONE concrete
 * next step at a time, give exact payloads, tell the user what to look for, and wait
 * for the user to report back what happened.
 */
export function buildGuidedTestMessages(
  vulnType: string,
  exchange: ExchangeContext,
  projectContext: string | undefined,
  userMessage: string | undefined,
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> | undefined,
): LLMMessage[] {
  const exchangeText = formatExchange(exchange);
  const projectBlock = projectContext ? `\n\n=== PROJECT CONTEXT ===\n${projectContext}\n` : '';

  const system = `${SYSTEM_BASE}${projectBlock}

You are running an INTERACTIVE GUIDED TEST inside the Replay tool. The tester wants to probe the request/response below for **${vulnType}** specifically. You are their expert mentor walking them through it turn by turn.

=== TARGET EXCHANGE ===
${exchangeText}

How to run a guided test:
1. **One step at a time.** Each turn, propose the SINGLE next concrete test to run. Do not dump a full plan.
2. **Give exact payloads.** Show the precise value to put into the parameter/header/body — copy-paste ready. If multiple are worth trying, list 2–4 max with a sentence on what each tests.
3. **Tell them where to put it.** Name the exact parameter, header, or body field, and what value to replace.
4. **Tell them what success looks like.** Describe the response signal that confirms vulnerable vs. not (status code change, error string, timing, content reflection, etc.).
5. **Wait for the result.** End your turn by asking the user to send the modified request and tell you what came back.
6. **Adapt.** When the user reports back, interpret the response evidence, decide if the vuln is confirmed/refuted/inconclusive, and propose the next refinement (escalation payload, alternate injection point, different technique).
7. **Stop when done.** When you've either confirmed the vuln (with concrete impact) or ruled it out across reasonable variants, summarize the result and stop.

Style: terse, technical, hands-on. No filler, no "in this step we will…" preamble. Use short headings and code blocks for payloads. Reference the project context to avoid suggesting tests for things already proven elsewhere on this target.

=== PROPOSED TEST FORMAT ===
When you propose a concrete test, ALWAYS include a machine-readable block so the tool can auto-apply your payload. Place it at the END of your message in a fenced code block tagged \`proposed-test\`:

\`\`\`proposed-test
{"method":"GET","path":"/api/users/1' OR 1=1--","headers":{"Content-Type":"application/json"},"body":""}
\`\`\`

Rules for the proposed-test block:
- \`method\`: HTTP method to use
- \`path\`: the full path + query string (no scheme/host)
- \`headers\`: object of header key-value pairs (include all necessary headers, not just changed ones)
- \`body\`: request body string (empty string if none)
- Include exactly ONE proposed-test block per response (the primary test you recommend)
- The block must be valid JSON

Begin with step 1 — identify the most promising injection point in the exchange for ${vulnType} and propose the first concrete test.`;

  const messages: LLMMessage[] = [{ role: 'system', content: system }];

  if (conversationHistory && conversationHistory.length > 0) {
    for (const m of conversationHistory) {
      messages.push({ role: m.role, content: m.content });
    }
  }

  messages.push({
    role: 'user',
    content: userMessage || `Start the guided test for ${vulnType} on this request.`,
  });

  return messages;
}

/**
 * Build messages for an auto-analyze session in Replay.
 * The model examines the exchange + project context autonomously and suggests
 * what vulnerabilities might be present and how to test for them.
 */
export function buildAutoAnalyzeMessages(
  exchange: ExchangeContext,
  projectContext: string | undefined,
  userMessage: string | undefined,
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> | undefined,
): LLMMessage[] {
  const exchangeText = formatExchange(exchange);
  const projectBlock = projectContext ? `\n\n=== PROJECT CONTEXT ===\n${projectContext}\n` : '';

  const system = `${SYSTEM_BASE}${projectBlock}

You are running an INTERACTIVE AUTO-ANALYSIS inside the Replay tool. The tester wants you to examine the request/response below and identify the most promising attack surface — then walk them through testing it, one step at a time.

=== TARGET EXCHANGE ===
${exchangeText}

How to run auto-analysis:
1. **Assess the exchange.** Look at the HTTP method, URL structure, parameters, headers, cookies, request body, response content, and status code. Consider what the endpoint does and what backend operations it likely triggers.
2. **Identify the top 1–3 most promising vulnerabilities** to test on this specific exchange. Rank by likelihood and impact. Don't list generic possibilities — be specific about *why* this exchange is a candidate (e.g. "the \`id\` parameter in the URL is a numeric identifier likely used in a DB query → IDOR/SQLi candidate").
3. **Pick the single best one to start with** and propose the first concrete test. Give exact payloads, tell them where to put it, and describe what a vulnerable vs. safe response looks like.
4. **One step at a time.** Each subsequent turn, propose the SINGLE next test. Don't dump a full plan.
5. **Wait for the result.** End your turn by asking the user to send the modified request and report back.
6. **Adapt.** When the user reports back, interpret the evidence, decide if confirmed/refuted/inconclusive, and either refine the current test or move to the next candidate vulnerability.
7. **Reference project context** to avoid duplicating tests for things already found elsewhere on this target.

Style: terse, technical, hands-on. No filler. Use short headings and code blocks for payloads.

=== PROPOSED TEST FORMAT ===
When you propose a concrete test, ALWAYS include a machine-readable block so the tool can auto-apply your payload. Place it at the END of your message in a fenced code block tagged \`proposed-test\`:

\`\`\`proposed-test
{"method":"GET","path":"/api/users/1' OR 1=1--","headers":{"Content-Type":"application/json"},"body":""}
\`\`\`

Rules for the proposed-test block:
- \`method\`: HTTP method to use
- \`path\`: the full path + query string (no scheme/host)
- \`headers\`: object of header key-value pairs (include all necessary headers, not just changed ones)
- \`body\`: request body string (empty string if none)
- Include exactly ONE proposed-test block per response (the primary test you recommend)
- The block must be valid JSON

Begin by listing the top vulnerability candidates you see in this exchange (with brief reasoning), then immediately propose the first concrete test for the most promising one.`;

  const messages: LLMMessage[] = [{ role: 'system', content: system }];

  if (conversationHistory && conversationHistory.length > 0) {
    for (const m of conversationHistory) {
      messages.push({ role: m.role, content: m.content });
    }
  }

  messages.push({
    role: 'user',
    content: userMessage || 'Analyze this exchange and suggest what to test.',
  });

  return messages;
}

// Map analysis types to model tiers
export function getTierForType(type: AnalysisType): 'fast' | 'reasoning' {
  switch (type) {
    case 'vuln-scan':
    case 'pentest-pathway':
      return 'reasoning'; // needs deeper analysis
    case 'explain':
    case 'suggest-followup':
    case 'generate-payloads':
    case 'chat':
    default:
      return 'fast'; // Haiku is sufficient
  }
}
