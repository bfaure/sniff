-- CreateTable
CREATE TABLE "Exchange" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "method" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "statusCode" INTEGER,
    "requestHeaders" TEXT NOT NULL,
    "requestBody" BLOB,
    "responseHeaders" TEXT,
    "responseBody" BLOB,
    "requestSize" INTEGER NOT NULL,
    "responseSize" INTEGER,
    "duration" INTEGER,
    "tlsVersion" TEXT,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "tags" TEXT NOT NULL DEFAULT '[]',
    "inScope" BOOLEAN NOT NULL DEFAULT true,
    "highlighted" BOOLEAN NOT NULL DEFAULT false,
    "errorMessage" TEXT
);

-- CreateTable
CREATE TABLE "Analysis" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "exchangeId" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "response" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL,
    "outputTokens" INTEGER NOT NULL,
    "costUsd" REAL NOT NULL,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Analysis_exchangeId_fkey" FOREIGN KEY ("exchangeId") REFERENCES "Exchange" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Finding" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "exchangeId" TEXT,
    "host" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "type" TEXT,
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "evidence" TEXT,
    "suggestedTest" TEXT,
    "method" TEXT,
    "url" TEXT,
    "categoryName" TEXT,
    "owaspId" TEXT,
    "cvss" REAL,
    "cvssVector" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "escalated" BOOLEAN NOT NULL DEFAULT false,
    "hits" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Finding_exchangeId_fkey" FOREIGN KEY ("exchangeId") REFERENCES "Exchange" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ScopeRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "protocol" TEXT,
    "host" TEXT NOT NULL,
    "port" INTEGER,
    "path" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "order" INTEGER NOT NULL
);

-- CreateTable
CREATE TABLE "FuzzerJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "attackType" TEXT NOT NULL,
    "templateReq" TEXT NOT NULL,
    "payloads" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "total" INTEGER NOT NULL,
    "concurrency" INTEGER NOT NULL DEFAULT 10,
    "throttleMs" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "FuzzerResult" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT NOT NULL,
    "payloads" TEXT NOT NULL,
    "statusCode" INTEGER NOT NULL,
    "responseSize" INTEGER NOT NULL,
    "duration" INTEGER NOT NULL,
    "responseBody" BLOB,
    "interesting" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "FuzzerResult_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "FuzzerJob" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Settings" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "NoiseFilter" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "pattern" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "shape" TEXT NOT NULL,
    "hitsTotal" INTEGER NOT NULL DEFAULT 0,
    "reason" TEXT NOT NULL DEFAULT 'auto',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "RepeaterTab" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "headers" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "RepeaterHistory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tabId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "method" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "headers" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "statusCode" INTEGER,
    "responseHeaders" TEXT,
    "responseBody" TEXT,
    "duration" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RepeaterHistory_tabId_fkey" FOREIGN KEY ("tabId") REFERENCES "RepeaterTab" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CostRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "modelId" TEXT NOT NULL,
    "feature" TEXT NOT NULL DEFAULT 'unknown',
    "inputTokens" INTEGER NOT NULL,
    "outputTokens" INTEGER NOT NULL,
    "costUsd" REAL NOT NULL,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "Exchange_host_idx" ON "Exchange"("host");

-- CreateIndex
CREATE INDEX "Exchange_timestamp_idx" ON "Exchange"("timestamp");

-- CreateIndex
CREATE INDEX "Exchange_method_idx" ON "Exchange"("method");

-- CreateIndex
CREATE INDEX "Exchange_statusCode_idx" ON "Exchange"("statusCode");

-- CreateIndex
CREATE INDEX "Exchange_errorMessage_idx" ON "Exchange"("errorMessage");

-- CreateIndex
CREATE INDEX "Analysis_exchangeId_idx" ON "Analysis"("exchangeId");

-- CreateIndex
CREATE INDEX "Analysis_type_idx" ON "Analysis"("type");

-- CreateIndex
CREATE UNIQUE INDEX "Finding_dedupeKey_key" ON "Finding"("dedupeKey");

-- CreateIndex
CREATE INDEX "Finding_host_idx" ON "Finding"("host");

-- CreateIndex
CREATE INDEX "Finding_status_idx" ON "Finding"("status");

-- CreateIndex
CREATE INDEX "Finding_severity_idx" ON "Finding"("severity");

-- CreateIndex
CREATE INDEX "Finding_createdAt_idx" ON "Finding"("createdAt");

-- CreateIndex
CREATE INDEX "ScopeRule_order_idx" ON "ScopeRule"("order");

-- CreateIndex
CREATE INDEX "FuzzerResult_jobId_idx" ON "FuzzerResult"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "NoiseFilter_pattern_key" ON "NoiseFilter"("pattern");

-- CreateIndex
CREATE INDEX "NoiseFilter_host_idx" ON "NoiseFilter"("host");

-- CreateIndex
CREATE INDEX "RepeaterHistory_tabId_sortOrder_idx" ON "RepeaterHistory"("tabId", "sortOrder");

-- CreateIndex
CREATE INDEX "CostRecord_timestamp_idx" ON "CostRecord"("timestamp");

-- CreateIndex
CREATE INDEX "CostRecord_modelId_idx" ON "CostRecord"("modelId");

-- CreateIndex
CREATE INDEX "CostRecord_feature_idx" ON "CostRecord"("feature");

