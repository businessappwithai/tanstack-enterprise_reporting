"use client";

import { AlertTriangle, Check, Copy, Mail, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import type { ErrorLog } from "@/lib/errors/error-logger";
import { errorLogger } from "@/lib/errors/error-logger";
import { getLogger } from "@/lib/logging/logger";

interface ErrorReportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  errorLog: ErrorLog | null;
}

export function ErrorReportDialog({ open, onOpenChange, errorLog }: ErrorReportDialogProps) {
  const [copied, setCopied] = useState(false);
  const [additionalInfo, setAdditionalInfo] = useState("");

  const errorReportingEmail =
    process.env.NEXT_PUBLIC_ERROR_REPORTING_EMAIL || "admin@yourcompany.com";

  if (!errorLog) return null;

  const emailData = errorLogger.generateErrorReportEmail(errorLog, errorReportingEmail);
  const fullEmailBody = additionalInfo
    ? `${emailData.body}\n\nUSER COMMENTS:\n${additionalInfo}`
    : emailData.body;

  const handleSendEmail = () => {
    const mailtoLink = `mailto:${errorReportingEmail}?subject=${encodeURIComponent(emailData.subject)}&body=${encodeURIComponent(fullEmailBody)}`;
    window.open(mailtoLink, "_blank");
  };

  const handleCopyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(fullEmailBody);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      getLogger("client").note("error", "Failed to copy to clipboard:", { err: err });
    }
  };

  const handleDismiss = () => {
    setAdditionalInfo("");
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleDismiss}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-destructive" />
            <DialogTitle>Error Report</DialogTitle>
          </div>
          <DialogDescription>
            An unexpected error occurred. Please help us improve by reporting this issue.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Error Summary */}
          <div className="p-4 rounded-lg bg-destructive/10 border border-destructive/20">
            <p className="font-mono text-sm font-semibold">{errorLog.errorMessage}</p>
            <p className="text-xs text-muted-foreground mt-1">{errorLog.timestamp}</p>
          </div>

          {/* Additional Information Input */}
          <div className="space-y-2">
            <label htmlFor="additional-info" className="text-sm font-medium">
              Additional Information (Optional)
            </label>
            <Textarea
              id="additional-info"
              placeholder="Describe what you were doing when this error occurred..."
              value={additionalInfo}
              onChange={(e) => setAdditionalInfo(e.target.value)}
              rows={3}
            />
          </div>

          {/* Email Body Preview */}
          <div className="space-y-2">
            <label htmlFor="email-preview" className="text-sm font-medium">
              Email Preview
            </label>
            <div className="relative">
              <Textarea
                id="email-preview"
                value={fullEmailBody}
                readOnly
                rows={10}
                className="font-mono text-xs resize-none"
              />
              <Button
                size="sm"
                variant="ghost"
                className="absolute top-2 right-2"
                onClick={handleCopyToClipboard}
              >
                {copied ? (
                  <>
                    <Check className="h-4 w-4 mr-1" />
                    Copied!
                  </>
                ) : (
                  <>
                    <Copy className="h-4 w-4 mr-1" />
                    Copy
                  </>
                )}
              </Button>
            </div>
            <p className="text-tremor-label text-tremor-content">
              This will be sent to <span className="font-mono">{errorReportingEmail}</span>
            </p>
          </div>

          {/* Instructions */}
          <div className="p-3 rounded-lg bg-muted border">
            <p className="text-tremor-default text-tremor-content">
              <strong>What happens next:</strong> Clicking &quot;Send Error Report&quot; will open
              your email client with the error details pre-filled. You can review the contents
              before sending.
            </p>
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={handleDismiss}>
            <X className="h-4 w-4 mr-2" />
            Dismiss
          </Button>
          <Button variant="outline" onClick={handleCopyToClipboard}>
            {copied ? (
              <>
                <Check className="h-4 w-4 mr-2" />
                Copied!
              </>
            ) : (
              <>
                <Copy className="h-4 w-4 mr-2" />
                Copy to Clipboard
              </>
            )}
          </Button>
          <Button onClick={handleSendEmail}>
            <Mail className="h-4 w-4 mr-2" />
            Send Error Report
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
