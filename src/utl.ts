import fs from 'fs';
import path from 'path';
import { lookup as mimeLookup } from 'mime-types';
import nodemailer from 'nodemailer';

/**
 * Helper function to encode email headers containing non-ASCII characters
 * according to RFC 2047 MIME specification
 */
function encodeEmailHeader(text: string): string {
    // Only encode if the text contains non-ASCII characters
    if (/[^\x00-\x7F]/.test(text)) {
        // Use MIME Words encoding (RFC 2047)
        return '=?UTF-8?B?' + Buffer.from(text).toString('base64') + '?=';
    }
    return text;
}

/**
 * Build a proper From header value with RFC 2047 encoding for non-ASCII
 * display names. Reads GMAIL_FROM env var (format: '"Display Name" <email>'
 * or 'email'). Falls back to GMAIL_FROM_NAME + GMAIL_FROM_ADDRESS combo.
 * If nothing set, defaults to 'me' (Gmail API substitutes, but display
 * name encoding may be lost — see commit notes for matchaday batch 2 bug).
 *
 * Roland 2026-05-15: 'me' caused mojibake "Roland VojkovskÃ½" in From
 * header because Gmail Send API substituted the authenticated user's
 * profile name without RFC 2047 encoding the UTF-8 bytes.
 */
function getFromHeader(): string {
    const explicit = process.env.GMAIL_FROM;
    if (explicit) return explicit;

    const name = process.env.GMAIL_FROM_NAME;
    const addr = process.env.GMAIL_FROM_ADDRESS;
    if (name && addr) {
        return `"${name}" <${addr}>`;
    }
    return 'me'; // legacy fallback — Gmail API substitutes (may mojibake)
}

export const validateEmail = (email: string): boolean => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
};

export function createEmailMessage(validatedArgs: any): string {
    const encodedSubject = encodeEmailHeader(validatedArgs.subject);
    // Determine content type based on available content and explicit mimeType
    let mimeType = validatedArgs.mimeType || 'text/plain';
    
    // If htmlBody is provided and mimeType isn't explicitly set to text/plain,
    // use multipart/alternative to include both versions
    if (validatedArgs.htmlBody && mimeType !== 'text/plain') {
        mimeType = 'multipart/alternative';
    }

    // Generate a random boundary string for multipart messages
    const boundary = `----=_NextPart_${Math.random().toString(36).substring(2)}`;

    // Validate email addresses
    (validatedArgs.to as string[]).forEach(email => {
        if (!validateEmail(email)) {
            throw new Error(`Recipient email address is invalid: ${email}`);
        }
    });

    // Build In-Reply-To + References from caller-provided RFC 822 Message-ID
    // (or fall back to raw inReplyTo; see createEmailWithNodemailer for full
    // explanation of why the resolved Message-ID is required for reply drafts).
    const inReplyToHeader = validatedArgs.inReplyToHeader || validatedArgs.inReplyTo;
    const referencesHeader = validatedArgs.referencesHeader || validatedArgs.inReplyToHeader || validatedArgs.inReplyTo;

    // Common email headers
    const emailParts = [
        `From: ${getFromHeader()}`,
        `To: ${validatedArgs.to.join(', ')}`,
        validatedArgs.cc ? `Cc: ${validatedArgs.cc.join(', ')}` : '',
        validatedArgs.bcc ? `Bcc: ${validatedArgs.bcc.join(', ')}` : '',
        `Subject: ${encodedSubject}`,
        // Add thread-related headers if specified
        inReplyToHeader ? `In-Reply-To: ${inReplyToHeader}` : '',
        referencesHeader ? `References: ${referencesHeader}` : '',
        'MIME-Version: 1.0',
    ].filter(Boolean);

    // Construct the email based on the content type
    if (mimeType === 'multipart/alternative') {
        // Multipart email with both plain text and HTML
        emailParts.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
        emailParts.push('');
        
        // Plain text part
        emailParts.push(`--${boundary}`);
        emailParts.push('Content-Type: text/plain; charset=UTF-8');
        emailParts.push('Content-Transfer-Encoding: 8bit');
        emailParts.push('');
        emailParts.push(validatedArgs.body);
        emailParts.push('');
        
        // HTML part
        emailParts.push(`--${boundary}`);
        emailParts.push('Content-Type: text/html; charset=UTF-8');
        emailParts.push('Content-Transfer-Encoding: 8bit');
        emailParts.push('');
        emailParts.push(validatedArgs.htmlBody || validatedArgs.body); // Use body as fallback
        emailParts.push('');
        
        // Close the boundary
        emailParts.push(`--${boundary}--`);
    } else if (mimeType === 'text/html') {
        // HTML-only email
        emailParts.push('Content-Type: text/html; charset=UTF-8');
        emailParts.push('Content-Transfer-Encoding: 8bit');
        emailParts.push('');
        emailParts.push(validatedArgs.htmlBody || validatedArgs.body);
    } else {
        // Plain text email (default)
        emailParts.push('Content-Type: text/plain; charset=UTF-8');
        emailParts.push('Content-Transfer-Encoding: 8bit');
        emailParts.push('');
        emailParts.push(validatedArgs.body);
    }

    return emailParts.join('\r\n');
}


export async function createEmailWithNodemailer(validatedArgs: any): Promise<string> {
    // Validate email addresses
    (validatedArgs.to as string[]).forEach(email => {
        if (!validateEmail(email)) {
            throw new Error(`Recipient email address is invalid: ${email}`);
        }
    });

    // Create a nodemailer transporter (we won't actually send, just generate the message)
    const transporter = nodemailer.createTransport({
        streamTransport: true,
        newline: 'unix',
        buffer: true
    });

    // Prepare attachments for nodemailer
    const attachments = [];
    for (const filePath of validatedArgs.attachments) {
        if (!fs.existsSync(filePath)) {
            throw new Error(`File does not exist: ${filePath}`);
        }
        
        const fileName = path.basename(filePath);
        
        attachments.push({
            filename: fileName,
            path: filePath
        });
    }

    // Build proper In-Reply-To + References headers.
    //
    // Roland 2026-05-20: caller may pass either:
    //   (a) a raw Gmail message id (e.g. '19e4410c0d200a90') — Gmail's
    //       internal short id used by the REST API, OR
    //   (b) a real RFC 822 Message-ID (e.g. '<CABx...@mail.gmail.com>')
    //       extracted from the original email's headers via
    //       gmail.users.messages.get(format='metadata').
    //
    // For draft-in-thread + attachments to render correctly in Gmail UI,
    // the In-Reply-To/References headers MUST be the RFC 822 Message-ID;
    // otherwise Gmail can't link the draft to the original message and the
    // compose pane silently breaks the attachments (shows only a 1KB
    // blocked.gif placeholder instead of the real files).
    //
    // The caller (index.ts) is expected to resolve raw Gmail ids → real
    // Message-IDs before invoking this helper. As a safety net we also
    // accept a separate `inReplyToHeader` field that takes precedence.
    const inReplyToHeader = validatedArgs.inReplyToHeader || validatedArgs.inReplyTo;
    const referencesHeader = validatedArgs.referencesHeader || validatedArgs.inReplyToHeader || validatedArgs.inReplyTo;

    const mailOptions = {
        // Explicit From with RFC 2047 encoding for non-ASCII display names
        // (nodemailer auto-encodes). Avoids 'me' substitution mojibake
        // (Roland 2026-05-15 matchaday batch 2 incident: "VojkovskÃ½").
        from: getFromHeader(),
        to: validatedArgs.to.join(', '),
        cc: validatedArgs.cc?.join(', '),
        bcc: validatedArgs.bcc?.join(', '),
        subject: validatedArgs.subject,
        text: validatedArgs.body,
        html: validatedArgs.htmlBody,
        attachments: attachments,
        inReplyTo: inReplyToHeader,
        references: referencesHeader
    };

    // Generate the raw message
    const info = await transporter.sendMail(mailOptions);
    let rawMessage = info.message.toString();

    // Fix CTE: Nodemailer may generate 'Content-Transfer-Encoding: 7bit'
    // for ASCII text parts, but Gmail draft renderer chokes on 7bit with
    // UTF-8 charset declaration → draft appears blank in compose UI.
    // Same root cause as the createEmailMessage() fix (commit 173c39f).
    // Post-process to 8bit which is RFC-valid for UTF-8 content.
    rawMessage = rawMessage.replace(
        /Content-Transfer-Encoding: 7bit/g,
        'Content-Transfer-Encoding: 8bit'
    );

    // Unfold RFC 5322 folded headers (Gmail attachment-chip rendering bug workaround).
    // Roland 2026-05-28 marker.sk incident: nodemailer folded
    //   Content-Type: application/pdf; name="LongFilename-Komplexny-...pdf"
    // onto a 2nd line (CRLF+TAB continuation) when the line exceeded ~78 chars.
    // Gmail's attachment-chip / quote rendering doesn't follow the continuation,
    // so it saw `application/pdf;` without `name=` → fell back to the previous
    // attachment's filename in its cache → both attachments displayed with the
    // SAME filename in the recipient's Gmail UI (even though the underlying PDF
    // bytes were correctly different — verified via gmail.users.messages.get).
    //
    // Krčmárik (marker.sk) saw "2× Linkbuilding-ponuka-Marker-2026.pdf" instead
    // of "Komplexny... + Linkbuilding..." and replied that one attachment was
    // missing. Real cause was display-layer dedup, not delivery failure.
    //
    // This unfolds all folded header continuations into single lines. Body
    // content (base64 / quoted-printable) never has leading whitespace on a
    // line, so we don't accidentally munge body data.
    rawMessage = rawMessage.replace(/\r?\n[\t ]+/g, ' ');

    return rawMessage;
}

