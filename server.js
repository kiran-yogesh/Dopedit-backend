const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const nodemailer = require('nodemailer');
const Razorpay = require('razorpay');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const cluster = require('cluster');
const os = require('os');

dotenv.config();

// Cache environment variables at module scope to avoid repeated process.env lookup overhead
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || 'rzp_test_z37ZcEwXJd4rS0';
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '6HlP9K9Kz5iF9g5cE5uN6f4A';
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const WHATSAPP_RECIPIENT_PHONE = process.env.WHATSAPP_RECIPIENT_PHONE || '919100961733';

const app = express();

// Secure backend by setting various HTTP headers
app.use(helmet());

// Enable Gzip compression to reduce network payload size and improve speed
app.use(compression());

app.use(cors());
app.use(express.json());

// Global Rate Limiter to protect all API endpoints from basic DDoS
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 150, // limit each IP to 150 requests per windowMs
  message: { error: 'Too many requests from this IP, please try again after 15 minutes.' }
});

// Strict Rate Limiter for payments & submissions to prevent abuse/spam
const strictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 15, // limit each IP to 15 submissions/orders per 15 minutes
  message: { error: 'Too many submissions from this IP, please try again after 15 minutes.' }
});

// Apply global rate limiting to all api endpoints
app.use('/api/', globalLimiter);

// Configure a single global pooled Nodemailer transporter
// The 'pool: true' keeps SMTP connections active, drastically reducing email dispatch latency under high load
const transporter = (EMAIL_USER && EMAIL_PASS) ? nodemailer.createTransport({
  pool: true,
  maxConnections: 10,
  maxMessages: 100,
  service: 'gmail',
  auth: {
    user: EMAIL_USER,
    pass: EMAIL_PASS
  }
}) : null;

const razorpay = new Razorpay({
  key_id: RAZORPAY_KEY_ID,
  key_secret: RAZORPAY_KEY_SECRET
});

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

// Payment Schema
const PaymentSchema = new mongoose.Schema({
  name: String,
  email: String,
  phone: String,
  packageName: String,
  amount: Number,
  currency: String,
  orderId: String,
  paymentId: String,
  signature: String,
  status: { type: String, enum: ['pending', 'completed', 'failed'], default: 'pending' },
  createdAt: { type: Date, default: Date.now }
});

// Index orderId to accelerate payment verification queries under 10x traffic loads
PaymentSchema.index({ orderId: 1 });

const Payment = mongoose.model('Payment', PaymentSchema);

// Programmatic WhatsApp notification helper via Meta WhatsApp Cloud API (optimized using module variables)
const sendWhatsAppNotification = async (messageText) => {
  if (!WHATSAPP_ACCESS_TOKEN || !WHATSAPP_PHONE_NUMBER_ID || WHATSAPP_ACCESS_TOKEN === 'your_meta_system_user_access_token' || WHATSAPP_PHONE_NUMBER_ID === 'your_meta_phone_number_id') {
    console.log('WhatsApp notification skipped: API keys are not configured or still placeholders.');
    console.log('Programmatic WhatsApp notification message details:\n', messageText);
    return false;
  }

  try {
    const url = `https://graph.facebook.com/v18.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: WHATSAPP_RECIPIENT_PHONE,
        type: 'text',
        text: {
          body: messageText
        }
      })
    });

    const data = await response.json();
    if (!response.ok) {
      console.error('Meta WhatsApp API Error response:', data);
      return false;
    }

    console.log('WhatsApp message sent successfully via Meta Cloud API:', data.messages[0].id);
    return true;
  } catch (error) {
    console.error('Failed to send WhatsApp message programmatically:', error);
    return false;
  }
};

// Endpoint to handle form submissions (protected by strict rate limiter)
app.post('/api/contact', strictLimiter, async (req, res) => {
  try {
    const { name, email, phone, service, message, selectedPackage } = req.body;
    
    if (mongoose.connection.readyState === 1) {
      const newContact = new Contact({ name, email, phone, service, message });
      await newContact.save();
    } else {
      console.log('Mock saving contact (DB disconnected):', { name, email, service });
    }

    // Format notification text with package info if applicable
    let packageInfo = "";
    if (selectedPackage && service === selectedPackage.name) {
      packageInfo = `\n\nPackage Selected: ${selectedPackage.name}\nPrice: ${selectedPackage.price} ${selectedPackage.period}\nBenefits:\n${selectedPackage.features.map(f => `  - ${f}`).join('\n')}`;
    }

    const notificationText = `Hello DOPEDITS STUDIO,\n\nYou received a new inquiry from your website!\n\nName: ${name}\nEmail: ${email}\nPhone: ${phone}\nService Needed: ${service}${packageInfo}\n\nMessage:\n${message}`;

    // Send email using Nodemailer (in background using pre-warmed global SMTP pool)
    try {
      if (transporter) {
        const mailOptions = {
          from: EMAIL_USER,
          to: 'kiranyogesh29@gmail.com',
          subject: `New Inquiry from ${name} - ${service}`,
          text: notificationText
        };

        transporter.sendMail(mailOptions)
          .then(() => console.log('Inquiry notification email sent successfully to kiranyogesh29@gmail.com'))
          .catch(emailError => console.error('Failed to send inquiry email:', emailError));
      } else {
        console.log('Email not sent: EMAIL_USER or EMAIL_PASS missing in .env');
      }
    } catch (emailError) {
      console.error('Failed to send inquiry notification email:', emailError);
    }

    // Send programmatic WhatsApp notification to admin (in background)
    sendWhatsAppNotification(notificationText)
      .then(success => {
        if (success) console.log('WhatsApp notification sent successfully.');
      })
      .catch(error => console.error('Failed to send WhatsApp notification:', error));
    
    res.status(201).json({ message: 'Request submitted successfully!' });
  } catch (error) {
    console.error('Contact submit error:', error);
    res.status(500).json({ error: 'Failed to submit request.' });
  }
});


// Endpoint to create a Razorpay order (protected by strict rate limiter)
app.post('/api/payment/order', strictLimiter, async (req, res) => {
  try {
    const { name, email, phone, packageName, amount } = req.body;
    
    if (!name || !email || !amount) {
      return res.status(400).json({ error: 'Name, email, and amount are required.' });
    }

    const options = {
      amount: Math.round(amount * 100), // amount in paise (1 INR = 100 paise)
      currency: 'INR',
      receipt: `receipt_order_${Date.now()}`
    };

    const order = await razorpay.orders.create(options);

    // Save pending payment details in database
    if (mongoose.connection.readyState === 1) {
      const newPayment = new Payment({
        name,
        email,
        phone,
        packageName,
        amount: amount,
        currency: 'INR',
        orderId: order.id,
        status: 'pending'
      });
      await newPayment.save();
    } else {
      console.log('Mock saving pending payment (DB disconnected):', { name, email, packageName, orderId: order.id });
    }

    res.status(201).json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      key_id: process.env.RAZORPAY_KEY_ID || 'rzp_test_z37ZcEwXJd4rS0'
    });
  } catch (error) {
    console.error('Create order error:', error);
    res.status(500).json({ error: 'Failed to create payment order.' });
  }
});

// Endpoint to verify Razorpay payment signature
app.post('/api/payment/verify', async (req, res) => {
  try {
    const { orderId, paymentId, signature, name, email, phone, packageName, amount } = req.body;
    
    const crypto = require('crypto');
    const secret = process.env.RAZORPAY_KEY_SECRET || '6HlP9K9Kz5iF9g5cE5uN6f4A';
    
    const generated_signature = crypto
      .createHmac('sha256', secret)
      .update(orderId + "|" + paymentId)
      .digest('hex');

    if (generated_signature !== signature) {
      // Update payment status to failed in database
      if (mongoose.connection.readyState === 1) {
        await Payment.findOneAndUpdate({ orderId: orderId }, { status: 'failed' });
      }
      return res.status(400).json({ error: 'Invalid payment signature. Verification failed.' });
    }

    // Update payment status to completed in database
    if (mongoose.connection.readyState === 1) {
      await Payment.findOneAndUpdate(
        { orderId: orderId },
        { 
          status: 'completed',
          paymentId: paymentId,
          signature: signature
        }
      );
    } else {
      console.log('Mock verifying payment (DB disconnected):', { orderId, paymentId });
    }

    // Send styled emails using Nodemailer (reusing the pre-warmed global SMTP pool)
    try {
      if (transporter) {
        // 1. Send confirmation email to client
        const clientMailOptions = {
          from: `"DOPEDITS STUDIO" <${EMAIL_USER}>`,
          to: email,
          subject: `Payment Confirmed! Your DOPEDITS Order is Placed 🎉`,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
              <h2 style="color: #ff0000; text-align: center;">DOPEDITS STUDIO</h2>
              <h3 style="color: #333;">Payment Confirmation</h3>
              <p>Hi <strong>${name}</strong>,</p>
              <p>Thank you for choosing DOPEDITS STUDIO! We have successfully received your payment for the <strong>${packageName}</strong> package.</p>
              <div style="background-color: #f9f9f9; padding: 15px; border-radius: 5px; margin: 20px 0;">
                <p style="margin: 5px 0;"><strong>Package Selected:</strong> ${packageName}</p>
                <p style="margin: 5px 0;"><strong>Amount Paid:</strong> ₹${amount}</p>
                <p style="margin: 5px 0;"><strong>Order Reference ID:</strong> ${orderId}</p>
                <p style="margin: 5px 0;"><strong>Payment Transaction ID:</strong> ${paymentId}</p>
              </div>
              <p>Our editing team is already gearing up! We will contact you at <strong>${phone}</strong> or via this email address within the next 24 hours to kick off your project.</p>
              <p>If you have raw files or assets ready, feel free to reply to this email or reach us directly via WhatsApp.</p>
              <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;" />
              <p style="font-size: 12px; color: #777; text-align: center;">This is an automated receipt for your purchase at DOPEDITS STUDIO.</p>
            </div>
          `
        };

        // 2. Send notification email to admin
        const adminMailOptions = {
          from: `"DOPEDITS STUDIO Payments" <${EMAIL_USER}>`,
          to: 'kiranyogesh29@gmail.com',
          subject: `🚨 NEW PAYMENT RECEIVED: ₹${amount} for ${packageName}`,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
              <h2 style="color: #4caf50; text-align: center;">New Order Received! 🚀</h2>
              <p>A new premium package has been paid for successfully.</p>
              <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
                <tr style="background-color: #f2f2f2;">
                  <td style="padding: 8px; font-weight: bold;">Package</td>
                  <td style="padding: 8px;">${packageName}</td>
                </tr>
                <tr>
                  <td style="padding: 8px; font-weight: bold;">Amount Paid</td>
                  <td style="padding: 8px; color: #4caf50; font-weight: bold;">₹${amount}</td>
                </tr>
                <tr style="background-color: #f2f2f2;">
                  <td style="padding: 8px; font-weight: bold;">Client Name</td>
                  <td style="padding: 8px;">${name}</td>
                </tr>
                <tr>
                  <td style="padding: 8px; font-weight: bold;">Client Email</td>
                  <td style="padding: 8px;"><a href="mailto:${email}">${email}</a></td>
                </tr>
                <tr style="background-color: #f2f2f2;">
                  <td style="padding: 8px; font-weight: bold;">Client Phone</td>
                  <td style="padding: 8px;"><a href="tel:${phone}">${phone}</a></td>
                </tr>
                <tr>
                  <td style="padding: 8px; font-weight: bold;">Order ID</td>
                  <td style="padding: 8px;">${orderId}</td>
                </tr>
                <tr style="background-color: #f2f2f2;">
                  <td style="padding: 8px; font-weight: bold;">Payment ID</td>
                  <td style="padding: 8px;">${paymentId}</td>
                </tr>
              </table>
              <p>Please review details and reach out to the client to begin working.</p>
            </div>
          `
        };

        transporter.sendMail(clientMailOptions)
          .then(() => console.log('Payment confirmation email successfully sent to client.'))
          .catch(emailError => console.error('Failed to send payment confirmation email to client:', emailError));

        transporter.sendMail(adminMailOptions)
          .then(() => console.log('Payment notification email successfully sent to admin.'))
          .catch(emailError => console.error('Failed to send payment notification email to admin:', emailError));
      } else {
        console.log('Payment emails not sent: EMAIL_USER or EMAIL_PASS missing in .env');
      }
    } catch (emailError) {
      console.error('Failed to send payment confirmation emails:', emailError);
    }

    res.status(200).json({ message: 'Payment verified and confirmed successfully!' });
  } catch (error) {
    console.error('Verify payment error:', error);
    res.status(500).json({ error: 'Failed to verify payment.' });
  }
});

const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://kiranyogesh29_db_user:Yiz3vjm5EVEZyJP7@cluster0.2g8ir7m.mongodb.net/?appName=Cluster0';

// Native Multi-Core Node.js Clustering implementation for 10x traffic processing capacity
if (cluster.isMaster) {
  const numCPUs = os.cpus().length || 1;
  console.log(`Master process ${process.pid} is running. Spawning ${numCPUs} multi-threaded workers...`);

  // Spawn matching workers to run on each available CPU core
  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }

  // Auto-recovery: If any worker process crashes, spawn a replacement worker immediately
  cluster.on('exit', (worker, code, signal) => {
    console.log(`Worker process ${worker.process.pid} died. Spawning replacement worker process...`);
    cluster.fork();
  });
} else {
  // Worker processes handle network traffic concurrently and share the PORT connection
  mongoose.connect(MONGO_URI, {
    maxPoolSize: 50,           // Optimize database connection pool to handle concurrent load
    minPoolSize: 10,           // Pre-warm database connections for instant request readiness
    socketTimeoutMS: 45000,    // Protect database queries from silent locks
    serverSelectionTimeoutMS: 5000
  })
    .then(() => {
      console.log(`Worker ${process.pid} successfully connected to MongoDB`);
      app.listen(PORT, () => {
        console.log(`Worker ${process.pid} listening on port ${PORT}`);
      });
    })
    .catch((err) => {
      console.error(`MongoDB connection failed on worker ${process.pid}. Reverting to Mock Mode.`);
      app.listen(PORT, () => {
        console.log(`Worker ${process.pid} listening on port ${PORT} (Mock Mode)`);
      });
    });
}
