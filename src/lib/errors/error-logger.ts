import { getLogger } from "@/lib/logging/logger";
export interface ErrorLog {
  timestamp: string;
  errorMessage: string;
  errorStack?: string;
  componentStack?: string;
  userAgent: string;
  url: string;
  userId?: string;
  metadata?: Record<string, any>;
}

class ErrorLogger {
  private logs: ErrorLog[] = [];
  private maxLogs = 50;

  logError(error: Error, errorInfo?: React.ErrorInfo, metadata?: Record<string, any>): ErrorLog {
    const errorLog: ErrorLog = {
      timestamp: new Date().toISOString(),
      errorMessage: error.message,
      errorStack: error.stack,
      componentStack: errorInfo?.componentStack ?? undefined,
      userAgent: typeof window !== "undefined" ? window.navigator.userAgent : "Unknown",
      url: typeof window !== "undefined" ? window.location.href : "Unknown",
      userId: this.getCurrentUserId(),
      metadata,
    };

    this.logs.unshift(errorLog);

    // Keep only the last maxLogs entries
    if (this.logs.length > this.maxLogs) {
      this.logs = this.logs.slice(0, this.maxLogs);
    }

    // Told to the server as well as kept here. This used to log in development only, so in
    // production a render error never left the browser: the first anyone heard of it was a
    // person describing a blank page. A warning or above is sent to the bounded /api/logs
    // route by the logger, and the System Logs screen shows it.
    getLogger("client").event("client.ui.failed", { what: `Render error: ${error.message}`, stack: error.stack,
      url: errorLog.url, });

    // Store in sessionStorage for persistence across page reloads
    try {
      sessionStorage.setItem("errorLogs", JSON.stringify(this.logs));
    } catch (_e) {
      // Ignore sessionStorage errors
    }

    return errorLog;
  }

  getLogs(): ErrorLog[] {
    return [...this.logs];
  }

  getLatestLog(): ErrorLog | null {
    return this.logs[0] || null;
  }

  clearLogs(): void {
    this.logs = [];
    try {
      sessionStorage.removeItem("errorLogs");
    } catch (_e) {
      // Ignore sessionStorage errors
    }
  }

  formatErrorForEmail(errorLog: ErrorLog): string {
    const sections = [
      "ERROR REPORT",
      "============",
      "",
      `Timestamp: ${errorLog.timestamp}`,
      `Error: ${errorLog.errorMessage}`,
      "",
    ];

    if (errorLog.errorStack) {
      sections.push("Stack Trace:");
      sections.push(errorLog.errorStack);
      sections.push("");
    }

    if (errorLog.componentStack) {
      sections.push("Component Stack:");
      sections.push(errorLog.componentStack);
      sections.push("");
    }

    sections.push("Context:");
    sections.push(`URL: ${errorLog.url}`);
    sections.push(`User Agent: ${errorLog.userAgent}`);
    if (errorLog.userId) {
      sections.push(`User ID: ${errorLog.userId}`);
    }

    if (errorLog.metadata) {
      sections.push("");
      sections.push("Additional Information:");
      sections.push(JSON.stringify(errorLog.metadata, null, 2));
    }

    return sections.join("\n");
  }

  generateErrorReportEmail(
    errorLog: ErrorLog,
    email: string
  ): { subject: string; body: string; to: string } {
    const body = this.formatErrorForEmail(errorLog);
    const subject = `[Error Report] ${errorLog.errorMessage.substring(0, 50)}${errorLog.errorMessage.length > 50 ? "..." : ""}`;

    return {
      to: email,
      subject,
      body,
    };
  }

  private getCurrentUserId(): string | undefined {
    try {
      const sessionData = sessionStorage.getItem("session");
      if (sessionData) {
        const session = JSON.parse(sessionData);
        return session.user?.id;
      }
    } catch (_e) {
      // Ignore errors
    }
    return undefined;
  }

  loadPersistedLogs(): void {
    try {
      const savedLogs = sessionStorage.getItem("errorLogs");
      if (savedLogs) {
        this.logs = JSON.parse(savedLogs);
      }
    } catch (_e) {
      // Ignore sessionStorage errors
    }
  }
}

export const errorLogger = new ErrorLogger();
