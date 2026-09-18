const express = require('express');
const db = require('../db');
const config = require('../config');
const { auth } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rate-limit');

const router = express.Router();
router.use(auth);

const rl = config.rateLimit;
const ticketL = rateLimit({ windowMs: rl.ticketMsg.windowMs, max: rl.ticketMsg.max, message: 'Too many support messages. Please wait a minute.' });

const pub = (t) => ({
  id: t.id, subject: t.subject, category: t.category, status: t.status,
  priority: t.priority, createdAt: t.created_at, updatedAt: t.updated_at,
  replyCount: t.reply_count, hasAdminReply: (t.user_count || 0) < (t.reply_count || 0),
});

// GET /api/tickets — my tickets
router.get('/', async (req, res) => {
  try {
    const tickets = await db.getTicketsByUser(req.userId);
    res.json({ tickets: tickets.map((t) => ({
      id: t.id, subject: t.subject, category: t.category, status: t.status,
      priority: t.priority, createdAt: t.created_at, updatedAt: t.updated_at,
    })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/tickets — create a ticket
router.post('/', ticketL, async (req, res) => {
  try {
    const { subject, category, priority, message } = req.body || {};
    if (!subject || !String(subject).trim()) return res.status(400).json({ error: 'Subject required' });
    if (!message || !String(message).trim()) return res.status(400).json({ error: 'Message required' });
    const ticket = await db.createTicket({
      userId: req.userId,
      subject: String(subject).trim(),
      category: String(category || 'general').trim(),
      priority: String(priority || 'normal').trim(),
    });
    await db.addTicketMessage({
      ticketId: ticket.id, senderId: req.userId, senderRole: 'user',
      message: String(message).trim(),
    });
    res.json({ ticket: pub(ticket) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/tickets/:id — ticket + conversation
router.get('/:id', async (req, res) => {
  try {
    const ticket = await db.getTicketById(req.params.id);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    if (ticket.user_id !== req.userId) return res.status(403).json({ error: 'Not your ticket' });
    const messages = await db.getTicketMessages(ticket.id);
    res.json({
      ticket: pub(ticket),
      messages: messages.map((m) => ({
        id: m.id, senderRole: m.sender_role, senderName: m.sender_name || (m.sender_role === 'admin' ? 'Support' : 'You'),
        message: m.message, createdAt: m.created_at,
      })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/tickets/:id/messages — reply on ticket
router.post('/:id/messages', ticketL, async (req, res) => {
  try {
    const { message } = req.body || {};
    if (!message || !String(message).trim()) return res.status(400).json({ error: 'Message required' });
    const ticket = await db.getTicketById(req.params.id);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    if (ticket.user_id !== req.userId) return res.status(403).json({ error: 'Not your ticket' });
    if (ticket.status === 'closed') return res.status(400).json({ error: 'Ticket is closed. Create a new ticket instead.' });
    const msg = await db.addTicketMessage({
      ticketId: ticket.id, senderId: req.userId, senderRole: 'user', message: String(message).trim(),
    });
    await db.updateTicket(ticket.id, { status: 'open', closed_at: null });
    res.json({ msg: 'Reply sent', message: { id: msg.id, message: msg.message, createdAt: msg.created_at } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/tickets/:id/close
router.post('/:id/close', async (req, res) => {
  try {
    const ticket = await db.getTicketById(req.params.id);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    if (ticket.user_id !== req.userId) return res.status(403).json({ error: 'Not your ticket' });
    await db.updateTicket(ticket.id, { status: 'closed', closed_at: db.now() });
    res.json({ msg: 'Ticket closed' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;