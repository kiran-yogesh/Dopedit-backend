const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const nodemailer = require('nodemailer');

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

// Basic Route
app.get('/', (req, res) => {
  res.send('DOPEDITS STUDIO API is running');
});

// Contact/Booking Schema
const ContactSchema = new mongoose.Schema({
  name: String,
  email: String,
  phone: String,
  service: String,
  message: String,
  createdAt: { type: Date, default: Date.now }
});

const Contact = mongoose.model('Contact', ContactSchema);

// Endpoint to handle form submissions
app.post('/api/contact', async (req, res) => {
  try {
    const { name, email, phone, service, message } = req.body;
    
    if (mongoose.connection.readyState === 1) {
      const newContact = new Contact({ name, email, phone, service, message });
      await newContact.save();
    } else {
      console.log('Mock saving contact (DB disconnected):', { name, email, service });
    }

    // Send email using Nodemailer
    try {
      if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
        const transporter = nodemailer.createTransport({
          service: 'gmail',
          auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS
          }
        });

        const mailOptions = {
          from: process.env.EMAIL_USER,
          to: 'kiranyogesh29@gmail.com',
          subject: `New Inquiry from ${name} - ${service}`,
          text: `Hi DOPEDITS STUDIO,\n\nYou received a new contact request from your website.\n\nName: ${name}\nEmail: ${email}\nPhone: ${phone}\nService: ${service}\n\nMessage:\n${message}`
        };

        await transporter.sendMail(mailOptions);
        console.log('Email sent successfully to kiranyogesh29@gmail.com');
      } else {
        console.log('Email not sent: EMAIL_USER or EMAIL_PASS missing in .env');
      }
    } catch (emailError) {
      console.error('Failed to send email:', emailError);
    }
    
    res.status(201).json({ message: 'Request submitted successfully!' });
  } catch (error) {
    console.error('Contact submit error:', error);
    res.status(500).json({ error: 'Failed to submit request.' });
  }
});

const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://kiranyogesh29_db_user:Yiz3vjm5EVEZyJP7@cluster0.2g8ir7m.mongodb.net/?appName=Cluster0';

mongoose.connect(MONGO_URI)
  .then(() => {
    console.log('Connected to MongoDB');
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('MongoDB connection failed. Starting server in mock mode.');
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT} (Mock Mode)`);
    });
  });
