import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';

export interface TicketPdfInput {
  ticketId: string;
  qrToken: string;
  eventTitle: string;
  venue: string;
  startsAt: Date;
  seatLabel: string;
  tier: string;
  pricePaise: number;
  attendeeEmail: string;
}

function formatInr(paise: number): string {
  return `INR ${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Renders one ticket (A6, QR code + details) entirely in memory. Pure: no I/O. */
export async function renderTicketPdf(input: TicketPdfInput): Promise<Buffer> {
  const qrPng = await QRCode.toBuffer(input.qrToken, { errorCorrectionLevel: 'M', margin: 1, width: 360 });

  const doc = new PDFDocument({ size: 'A6', margin: 24, info: { Title: `Ticket ${input.seatLabel} - ${input.eventTitle}` } });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    doc.on('error', reject);
  });

  doc.fontSize(8).fillColor('#666666').text('TICKETFLOW · ADMIT ONE');
  doc.moveDown(0.3).fontSize(14).fillColor('#000000').text(input.eventTitle, { width: 250 });
  doc.moveDown(0.2).fontSize(9).fillColor('#333333').text(input.venue);
  doc.text(input.startsAt.toUTCString());
  doc.moveDown(0.5).fontSize(12).fillColor('#000000').text(`Seat ${input.seatLabel}  ·  ${input.tier}`);
  doc.fontSize(9).fillColor('#333333').text(formatInr(input.pricePaise));
  doc.image(qrPng, (doc.page.width - 150) / 2, doc.y + 8, { width: 150 });
  doc.y += 166;
  doc.fontSize(7).fillColor('#666666').text(`Ticket ${input.ticketId}`, { align: 'center' });
  doc.text(input.attendeeEmail, { align: 'center' });
  doc.end();
  return done;
}
