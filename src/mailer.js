import nodemailer from "nodemailer";

/** SMTP mailer for alerts; null when SMTP is not configured. */
export function createMailer(config) {
  if (!config.smtp) return null;
  const transport = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.port === 465,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
  });
  return {
    async send({ to, subject, text }) {
      await transport.sendMail({ from: config.smtp.from, to, subject, text });
    },
  };
}
