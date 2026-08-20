# SSOT — Prompt-Bound Temporary GitHub Access Gateway

**Status:** Source of Truth  
**Scope:** GitHub Code Review / Audit / E2E read access from ChatGPT through the browser extension  
**Security boundary:** Extension-backed approval + prompt-bound temporary lease

---

## 1. هدف

هدف، ساخت یک **Approval Gateway** بین ChatGPT و GitHub است؛ به‌گونه‌ای که ChatGPT هیچ‌وقت صرفاً به دلیل حضور در یک Conversation، داشتن یک Session قبلی، یا وجود PAT در Proxy نتواند اطلاعات جدیدی از GitHub دریافت کند.

هر GitHub Read جدید باید از Gate عبور کند.

```text
ChatGPT
   ↓ GitHub read requested
Approval Gateway
   ↓
Browser Extension
   ↓ explicit user approval
Prompt-bound Temporary Lease
   ↓
Gateway / Proxy
   ↓
GitHub
```

MCP حذف نشده و همچنان **Transport / Tool Execution Mechanism** این Flow است. Extension برای اجرای Toolهای GitHub از MCP با Transport نوع `Streamable HTTP` استفاده می‌کند؛ Gateway فقط لایه‌ی Security Enforcement جلوی MCP Proxy است و جای MCP را نمی‌گیرد.

هسته امنیت، Gate و Lease هستند؛ MCP لایه‌ی انتقال و اجرای Tool باقی می‌ماند.

---

## 2. قانون اصلی Approval

فرمول رسمی سیستم:

```text
Approval = Repo + UserPrompt/UserTurn + Origin + Time Window
```

و صراحتاً نه:

```text
Approval = Repo + Chat + Time
```

داشتن یک Chat فعال یا Lease مربوط به Prompt قبلی برای Prompt بعدی کافی نیست.

---

## 3. Review Job

هر Prompt واقعی کاربر که برای انجام آن GitHub لازم باشد، یک `ReviewJob` مستقل دارد.

نمونه منطقی:

```text
ReviewJob {
  jobId
  repo
  userTurnId
  originTabId
  conversationPath
  requestedAt
  approvedAt
  durationMinutes
  expiresAt
  readOnly
  status
}
```

- `jobId` باید یکتا و غیرقابل حدس باشد.
- `userTurnId` مشخص می‌کند این مجوز دقیقاً متعلق به کدام Prompt واقعی کاربر است.

---

## 4. رفتار قبل از Approval

GitHub Code Review به‌صورت پیش‌فرض `OFF` است.

وقتی OFF است، هیچ GitHub Read واقعی نباید قابل اجرا باشد.

مدل فقط می‌تواند:

```text
request_code_review_access
```

را invoke کند.

این Tool:

- GitHub را نمی‌خواند.
- PAT را دریافت نمی‌کند.
- Repo انتخاب نمی‌کند.
- Duration انتخاب نمی‌کند.
- فقط درخواست Approval ایجاد می‌کند.

---

## 5. Repo و Duration فقط توسط کاربر

Repo و مدت دسترسی فقط در Extension/Security Settings توسط کاربر تعیین می‌شوند.

Durationهای فعلی:

```text
5 دقیقه
10 دقیقه
20 دقیقه
```

مدل حق ندارد Repo یا Duration دیگری انتخاب، پیشنهاد یا تمدید کند.

---

## 6. زمان ایجاد Pending

این موارد به‌تنهایی نباید Pending ایجاد کنند:

```text
Insert MCP Instructions
Open MCP UI
Refresh
New Chat
Reload Extension
Show Instructions
Tool discovery
```

Pending فقط وقتی ساخته می‌شود که:

1. Prompt واقعی کاربر نیازمند GitHub باشد.
2. مدل واقعاً `request_code_review_access` را invoke کند.

```text
request_code_review_access
↓
Pending Request
↓
Extension UI
↓
Approve / Reject
```

---

## 7. Explicit Approval

Approval همیشه باید صریح باشد.

این موارد Approval محسوب نمی‌شوند:

```text
مدل قبلاً Approval داشته
همان Chat است
همان Repo است
زمان قبلی هنوز تمام نشده
Prompt مشابه Prompt قبلی است
```

فقط اقدام واقعی کاربر در Extension یعنی `Approve` باعث ایجاد Lease می‌شود.

---

## 8. Prompt-Bound Lease

پس از Approve:

```text
Lease {
  jobId
  repo
  userTurnId
  origin
  expiresAt
  readOnly: true
}
```

Invariant اصلی:

```text
Valid GitHub Read =
Same Repo
+ Same Approved UserTurn
+ Same Origin
+ Lease Not Expired
+ Read-only Tool
```

اگر حتی یکی برقرار نباشد:

```text
DENY
```

---

## 9. آزادی مدل داخل همان Prompt

Lease نباید به یک فایل یا Directory خاص محدود شود.

برای مثال اگر کاربر بگوید:

```text
E2E پرداخت را بررسی کن.
```

و 20 دقیقه Approval بدهد، مدل باید بتواند در همان Repo بین تمام بخش‌های لازم حرکت کند:

```text
API
Controller
DTO / Schema
Validator / Pipe
Mapper / Presenter / Serializer
Resolver
Service
Application Service / Use Case
Repository / Adapter
Module Wiring
Consumers
Writers / Readers
Database
Shared Packages
Frontend
Tests
Configuration
Direct dependencies
Impact surface
Regression risk
```

در همان Job مدل ممکن است تعداد زیادی Tool Call انجام دهد و برای هر Tool Call Approval جدید نباید گرفته شود.

---

## 10. عدم محدودیت Path مصنوعی

برای Reviewهای معماری، Audit و E2E نباید مدل به یک Subdirectory محدود شود؛ چون Implementation واقعی ممکن است بین چند app/package پخش شده باشد.

Scope اصلی:

```text
Approved Repo
```

است، نه یک Path محدود.

محدودیت Path مصنوعی می‌تواند باعث شود مدل تصور کند بخشی پیاده‌سازی نشده و پیشنهاد موازی‌کاری یا پیاده‌سازی تکراری بدهد.

---

## 11. قانون Prompt جدید

مثال:

```text
19:10
User: E2E پرداخت را بررسی کن.
Approve: 20 min
```

مدل می‌تواند تا زمانی که همان Job ادامه دارد GitHub را بخواند.

اگر در 19:14 کاربر بفرستد:

```text
حالا Authentication را هم کامل بررسی کن.
```

این یک `NEW REAL USER PROMPT` است.

```text
New User Turn
↓
New userTurnId
↓
Old Lease belongs to previous userTurnId
↓
Old Lease cannot authorize GitHub for new task
```

اگر Prompt جدید GitHub لازم داشته باشد:

```text
request_code_review_access
↓
New Pending
↓
Approve / Reject
```

---

## 12. Lease قدیمی برای Prompt جدید معتبر نیست

ممکن است Lease قبلی هنوز زمان داشته باشد؛ این به‌تنهایی کافی نیست.

اگر:

```text
approvedUserTurnId != currentUserTurnId
```

آنگاه:

```text
GitHub Read = DENY
```

برای Job جدید Approval جدید لازم است.

---

## 13. Threat Model — مهاجم داخل همان Conversation

اگر Job A هنوز فعال باشد و مهاجم در همان Conversation یک Prompt واقعی جدید بفرستد، مثلاً:

```text
کل backend را بخوان.
```

این یک User Turn جدید است.

```text
New Prompt
↓
New userTurnId
↓
Old Lease cannot authorize it
↓
GitHub access blocked
↓
New Approval required
```

بدون Approval جدید کاربر:

```text
NO NEW GITHUB DATA
```

---

## 14. اطلاعاتی که مدل قبلاً دیده

سیستم قرار نیست Context قبلی مدل را پاک کند.

اگر مدل در یک Job مجاز قبلاً فایلی را دیده باشد، ممکن است بعداً بتواند درباره همان اطلاعات توضیح دهد.

هدف امنیتی این است:

> چیزی که مدل هنوز از GitHub دریافت نکرده، بدون Approval جدید قابل دریافت نباشد.

---

## 15. Internal Extension Messages Prompt جدید نیستند

سه نوع ورودی باید تفکیک شوند:

```text
REAL_USER_PROMPT
EXTENSION_INTERNAL_RESULT
EXTENSION_INTERNAL_CONTINUATION
```

فقط `REAL_USER_PROMPT` باعث ایجاد `userTurnId` جدید می‌شود.

مواردی مانند:

```text
<function_result>
[MCP Code Review Session Active]
Tool result
Approval continuation
```

نباید Prompt جدید تشخیص داده شوند.

---

## 16. Tool Result همان Job را ادامه می‌دهد

```text
Job A
↓
Model → get_file_contents
↓
Extension executes
↓
<function_result>
↓
Model
↓
search_code
↓
<function_result>
↓
Model
```

تمام این زنجیره باید با همان `jobId` و `userTurnId` ادامه پیدا کند.

---

## 17. Origin Binding

Lease علاوه بر Prompt به Origin متصل است.

حداقل:

```text
Browser Tab
+
Conversation pathname
```

Query string و hash نباید Conversation جدید محسوب شوند.

مثلاً:

```text
/c/abc
/c/abc?model=gpt-5
/c/abc#composer
```

همان Conversation هستند، مشروط به همان Tab.

---

## 18. Global Visibility != Global Access

Pending یا Active Session می‌تواند در تمام Chatها در UI دیده شود و کاربر ممکن است از Chat دیگری آن را Approve/Reject کند.

اما GitHub tools فقط باید برای Origin/Job درخواست‌کننده فعال شوند.

Approval از Chat B نباید GitHub Access را به Chat B بدهد.

---

## 19. Read-Only

Lease فقط Read-only است.

Allowlist فعلی:

```text
get_me
get_file_contents
get_repository_tree
search_code
list_commits
get_commit
get_file_blame
list_branches
list_tags
get_tag
list_pull_requests
pull_request_read
```

هر GitHub Write Tool باید مسدود باشد.

---

## 20. Repository Scope Enforcement

Repo باید قبل از تماس با GitHub enforce شود.

مدل نباید بتواند با تغییر Tool args از Repo تأییدشده خارج شود.

هر Repo mismatch باید قبل از GitHub `DENY` شود.

---

## 21. Search Escape Prevention

`search_code` نباید بتواند با qualifier از Repo خارج شود.

مواردی مانند:

```text
repo:
org:
user:
owner:
```

باید مسدود شوند یا Gateway Scope authoritative را خودش enforce کند.

---

## 22. GitHub PAT

GitHub PAT:

```text
هرگز به مدل داده نمی‌شود
هرگز در Prompt قرار نمی‌گیرد
هرگز داخل function_result قرار نمی‌گیرد
هرگز Tool Parameter مدل نیست
```

PAT فقط در Backend/Proxy امن نگهداری می‌شود.

---

## 23. Capability / Lease Credential

Approval کاربر باید یک Credential موقت داخلی ایجاد کند که می‌تواند شامل این موارد باشد:

```text
capabilityId
jobId
repo
origin
userTurnId
expiresAt
permissions
```

اما مدل نباید secret آن را ببیند.

Extension/Gateway این Credential را Out-of-Band مدیریت می‌کنند.

---

## 24. Proxy Enforcement

وجود PAT در Proxy به‌تنهایی نباید به معنی GitHub Access باشد.

```text
PAT exists ✅
Capability missing ❌
→ GitHub Read DENIED
```

بنابراین حتی client مستقیم Proxy نیز بدون Capability معتبر نباید بتواند GitHub را بخواند.

---

## 24.1. Secure Local MCP Runtime و الزام `127.0.0.1`

MCP در این معماری حذف یا دور زده نشده است. اتصال Browser Extension به Runtime همچنان یک اتصال MCP با Transport نوع `Streamable HTTP` است. Gateway فقط جلوی MCP Proxy قرار می‌گیرد تا قبل از هر GitHub Read، Capability و Scope را enforce کند.

Endpoint رسمی و Canonical روی Host:

```text
Transport: Streamable HTTP
URL: http://127.0.0.1:38106/mcp
```

برای Front Door روی Host باید از `127.0.0.1` استفاده شود، نه `localhost`.

```text
Host bind = 127.0.0.1
Host published port = 38106 only
```

علت این الزام این است که `localhost` می‌تواند بسته به Resolver سیستم به IPv4 یا IPv6 مانند `::1` resolve شود و باعث ambiguity، تفاوت رفتار یا bind ناخواسته شود. در Security Boundary مربوط به Host باید Loopback به‌صورت صریح با `127.0.0.1` مشخص شود.

توپولوژی Runtime فعلی:

```text
ChatGPT / Browser Extension
        ↓
MCP Streamable HTTP
http://127.0.0.1:38106/mcp
        ↓
Host-published loopback port only
        ↓
[ Isolated Secure Runtime Container ]
        ↓
Front-door forwarder :38106
        ↓
Capability Gateway 127.0.0.1:38108
        ↓
PAT-bearing MCP Proxy :38107
        ↓
Official GitHub MCP Server binary (same isolated runtime)
        ↓
GitHub
```

قواعد الزامی این Runtime:

```text
Host-visible:
127.0.0.1:38106 only

Host-not-published:
38107 PAT-bearing MCP Proxy
38108 internal Capability Gateway
```

پورت `38107` که PAT-bearing MCP Proxy روی آن اجرا می‌شود نباید به Host publish شود. پورت داخلی Gateway نیز نباید مستقیماً روی Host publish شود. تنها Front Door مجاز، `127.0.0.1:38106` است و درخواست از آنجا باید قبل از رسیدن به Proxy از Capability Gateway عبور کند.

داخل Secure Runtime، Gateway علاوه بر Policy اصلی باید موارد زیر را دوباره enforce کند:

```text
Valid Extension device credential
Active prompt-bound Lease
Same approved Repo
Read-only tool allowlist
Lease expiry
Revoke state
Search scope restrictions
```

وجود MCP Server یا PAT پشت Runtime هرگز به‌تنهایی مجوز Read نیست.

### Secure Bootstrap

MCP config و GitHub credential نباید برای Secure Runtime به‌صورت bind-mounted فایل معمولی یا Docker command argument منتقل شوند. Config امنیتی باید immutable و داخل Image ساخته شود تا کاربر، مدل یا یک MCP جایگزین نتواند provenance ابزارهای GitHub را تغییر دهد.

روش فعلی:

```text
Host github.env
      ↓ stdin stream (credential only)
Container-only tmpfs /run/bootstrap
      ↓
github.env with umask 077
Immutable image-owned config.json
      ↓
Secure Runtime starts
```

هدف:

```text
PAT not in model context
PAT not in MCP tool args/results
PAT not in Docker command arguments
PAT not in docker inspect environment
PAT not bind-mounted from host
Bootstrap files exist only in container tmpfs
MCP server command/provenance not configurable from host
```

Secure Runtime با hardening زیر اجرا می‌شود:

```text
--cap-drop ALL
--security-opt no-new-privileges
--read-only container filesystem
non-root runtime user
container-only tmpfs for bootstrap secrets
no host publish for PAT-bearing upstream
no Docker socket or Docker CLI inside runtime
```

GitHub MCP Server به‌صورت باینری رسمی و مستقیم داخل همان Secure Runtime اجرا می‌شود. Runtime نباید Docker socket یا Docker CLI داشته باشد؛ در نتیجه حتی compromise شدن processهای Runtime نیز مسیر ساخت container جدید، mount کردن Host یا publish کردن پورت PAT-bearing ایجاد نمی‌کند.

### Fail-Closed Network Invariant

Runtime صحیح روی Host باید این وضعیت را داشته باشد:

```text
127.0.0.1:38106 LISTEN ✅
38107 host LISTEN ❌
38108 host LISTEN ❌
```

و درخواست مستقیم به Front Door بدون Extension credential / Capability معتبر باید قبل از GitHub رد شود:

```text
PAT exists ✅
MCP runtime exists ✅
Extension capability missing ❌
→ HTTP 401/403
→ NO NEW GITHUB DATA
```

بنابراین تغییر از `localhost` به `127.0.0.1` صرفاً تغییر نام Host نیست؛ بخشی از Binding صریح Security Boundary و توپولوژی Secure Local MCP Runtime است.

---

## 25. Extension Requirement

اگر مهاجم Conversation را روی دستگاه دیگری باز کند:

```text
ChatGPT account ✅
Conversation ✅
Previously known context ✅
User Extension ❌
Valid Capability ❌
New GitHub Read ❌
```

---

## 26. Expiry

Lease فقط برای Duration انتخاب‌شده معتبر است.

```text
expiresAt reached
↓
Capability invalid
↓
Read tools removed
↓
Proxy DENY
```

Expiry خودکار است.

---

## 27. No Automatic Renewal

Lease تمدید خودکار ندارد.

اگر همان Job پس از expiry هنوز GitHub لازم داشته باشد:

```text
request_code_review_access
↓
New Approval
```

---

## 28. Revoke Now

کاربر باید در هر لحظه بتواند `Revoke Now` بزند.

اثر باید فوری باشد:

```text
Lease invalid
Capability invalid
GitHub reads blocked
Read tools removed
```

---

## 29. Limits

Baseline فعلی Abuse Ceiling:

```text
Max calls: 200 / Lease
Max single response: 2 MB
Max total response: 25 MB / Lease
```

این محدودیت‌ها Scope امنیتی نیستند؛ Abuse Ceiling هستند و نباید E2E/Architecture traversal را مصنوعی محدود کنند.

اگر تست واقعی Monorepo نشان دهد سقف فعلی ناکافی است، سقف باید جداگانه بازنگری شود؛ نه اینکه با محدودکردن Path مشکل دور زده شود.

---

## 30. Large Monorepo / E2E Requirement

`Adiuse/shaahane-monorepo` نمونه مرجع Acceptance برای این قابلیت است.

یک Prompt واحد E2E ممکن است نیاز داشته باشد بین چند Workspace رفت‌وبرگشت کند، مثل:

```text
apps/web
↓
apps/api
↓
packages/checkout-core
↓
packages/billing
↓
packages/db
↓
packages/security-kit
↓
tests
```

Gate نباید در میانه همان Job Approval جدید بخواهد مگر در یکی از این حالات:

```text
Time expired
User revoked
New real user prompt
Policy violation
Abuse limit reached
```

---

## 31. Audit Requirement

Audit عمیق ممکن است علاوه بر فایل هدف Context معماری لازم را بررسی کند، شامل:

```text
Upstream architecture
Downstream architecture
DTO / Schema
Validator / Pipe
Mapper / Presenter / Serializer
Resolver
Service
Application Service / Use Case
Repository / Adapter
Module Wiring
Consumers
Writers
Readers
Direct dependencies
Impact surface
Regression risk
```

این Requirement تأیید می‌کند که Repo-wide Read داخل همان Job ضروری است.

---

## 32. Audit Automation مستقل از Core Gate

Automation محلی Audit می‌تواند بعداً روی همین Approval Gateway سوار شود.

الگوی مطلوب:

```text
sg first
↓
grep for linear context / Patch+ anchors
↓
exclude .bak*
↓
exclude build metadata
↓
minimal terminal output
↓
archive result
↓
/tmp/lan-share
```

اما این قابلیت جزء Core GitHub Access Gateway نیست و Gate نباید به Shell محلی وابسته شود.

---

## 33. Audit Log

حداقل Eventهای زیر باید ثبت شوند:

```text
access_requested
access_approved
access_rejected
job_started
job_expired
job_revoked
tool_allowed
tool_denied
response_allowed
response_denied
scope_violation
new_user_turn_invalidated_old_job
```

Audit باید `jobId` و در صورت امکان `userTurnId` را ثبت کند.

---

## 34. Notifications

اعلان‌های Code Review داخل Chat/MCP UI نمایش داده می‌شوند.

Desktop/System Notification برای این Flow لازم نیست.

Pending باید حداقل Toast + Pending Card قابل مشاهده داشته باشد.

---

## 35. Approval UI

Pending باید حداقل اطلاعات زیر را نشان دهد:

```text
Repository
Duration
Origin conversation
Requested time
Prompt/Job identity
Approve
Reject
```

هیچ Secret/Token نباید نمایش داده شود.

---

## 36. Auto Resume

بعد از Approval مدل باید همان Task را ادامه دهد، اما Auto Resume فقط وقتی انجام شود که Read tools واقعاً برای همان Origin/Job expose شده باشند.

نباید پیام fake «Access granted» ارسال شود در حالی که Capability عملیاتی آماده نیست.

---

## 37. Tool Result Handling

نتیجه GitHub باید به همان Job و همان Conversation برگردد:

```text
GitHub
↓
Gateway
↓
Extension
↓
function_result
↓
Same model conversation/job
```

Tool Result یک Prompt انسانی جدید محسوب نمی‌شود.

---

## 38. GitHub Authentication Failure

اگر Backend/MCP نیازمند Authentication باشد، Challengeهایی مثل Device Login / Missing PAT / Credential Failure نباید به‌عنوان Repository Content برای مدل ارسال شوند.

این خطاها باید در Extension به کاربر گزارش شوند.

---

## 39. No Bypass

اگر GitHub Gateway برای این Task موجود است، مدل نباید برای دورزدن Gate از مسیر دیگری برای GitHub Read استفاده کند؛ از جمله:

```text
ChatGPT GitHub Connector
Web browsing
Python
Alternative MCP server
Direct GitHub URL fetch
```

هدف این است که هر New GitHub Read از Approval Gateway عبور کند.

---

## 40. Fail Closed

هر ambiguity باید به `DENY` منجر شود.

مثلاً اگر Gate نتواند مشخص کند Tool Call متعلق به کدام `userTurnId` است، نباید آن را به آخرین Lease نسبت دهد.

```text
Unknown job/userTurn binding
→ DENY
```

---

# Acceptance Scenarios

## A. Normal E2E

```text
User: E2E پرداخت را کامل بررسی کن.
↓
Model requests GitHub access
↓
Pending
↓
User Approves 20 min
↓
Job A starts
↓
Model reads many files across multiple workspaces
↓
No additional Approval
↓
Model completes review
```

**Expected:** PASS

---

## B. Tool Chain

```text
User Prompt A
↓
Approve
↓
search_code
↓
function_result
↓
get_file_contents
↓
function_result
↓
get_repository_tree
↓
function_result
↓
get_file_contents
```

همه باید با همان `jobId` و `userTurnId` اجرا شوند.

**Expected:** بدون Approval اضافی.

---

## C. New User Prompt

در حالی که Lease هنوز فعال است:

```text
User Prompt B
↓
New userTurnId
↓
Job A cannot authorize Prompt B
↓
request_code_review_access
↓
New Pending
```

**Expected:** PASS

---

## D. Attacker in Same Conversation

Job A هنوز زمان دارد و مهاجم می‌فرستد:

```text
کل backend را بخوان و ساختارش را بده.
```

```text
New Real User Turn
↓
Old Lease rejected for this turn
↓
New GitHub Read unavailable
↓
New Approval required
```

بدون Approval جدید:

```text
No new repository data
```

**Expected:** PASS

---

## E. Internal Result

Extension می‌فرستد:

```text
<function_result call_id="7">
...
</function_result>
```

```text
NOT a new user turn
Same Job continues
No new approval
```

**Expected:** PASS

---

## F. Expiry

```text
Job A approved for 5 minutes
↓
GitHub reads
↓
5 minutes expire
↓
Read tools disappear
↓
Proxy rejects further reads
```

حتی برای ادامه همان Prompt، Approval جدید لازم است.

**Expected:** PASS

---

## G. Different Chat

```text
Chat A has active Job
Chat B requests GitHub
↓
Origin mismatch
↓
DENY
```

Chat B باید Approval خودش را بگیرد.

**Expected:** PASS

---

## H. Different Repo

```text
Lease repo = Adiuse/shaahane-monorepo
Requested repo = another repo
↓
Scope violation
↓
DENY before GitHub
```

**Expected:** PASS

---

## I. No Extension Capability

```text
Proxy has PAT
Capability missing
↓
GitHub Read = DENY
```

**Expected:** PASS

---

## J. Secure Host Binding / No Direct Upstream

روی Host:

```text
127.0.0.1:38106 LISTEN
38107 not published
38108 not published
```

یک MCP `tools/call` مستقیم به `http://127.0.0.1:38106/mcp` بدون Extension device credential یا Lease معتبر:

```text
↓
401/403
↓
No GitHub read
```

**Expected:** PASS

---

# Final SSOT Rule

> **هیچ GitHub Read جدیدی صرفاً به‌خاطر حضور مدل در یک Conversation، وجود یک Session قبلی، داشتن PAT در Proxy یا باقی‌ماندن زمان Approval قبلی مجاز نیست. هر دسترسی باید به Repo، Origin، Prompt/UserTurn واقعی کاربر و Time Window تأییدشده متصل باشد.**
>
> **MCP همچنان Transport / Tool Execution Mechanism این Flow است. Endpoint رسمی Extension روی Host، `http://127.0.0.1:38106/mcp` با `Streamable HTTP` است و فقط همین Front Door روی Host publish می‌شود؛ PAT-bearing MCP Proxy و Gateway داخلی نباید مستقیم روی Host publish شوند.**
>
> **داخل همان UserPrompt/ReviewJob، مدل باید بتواند بدون Approval مجدد در تمام Repo حرکت Read-only داشته باشد تا بررسی‌های معماری، Audit و E2E ناقص نشوند.**
>
> **به محض دریافت یک Prompt واقعی جدید از کاربر، Lease قبلی حق تأیید GitHub Read برای آن Prompt جدید را ندارد، حتی اگر هنوز منقضی نشده باشد. پیام‌های داخلی Extension و Tool Resultها Prompt جدید نیستند و همان Job را ادامه می‌دهند.**
>
> **بدون Capability معتبر صادرشده در نتیجه Approval Extension، Proxy حتی با وجود GitHub PAT نباید هیچ داده جدیدی از GitHub در اختیار مدل قرار دهد.**
