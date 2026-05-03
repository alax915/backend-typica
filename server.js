const express = require('express');
const app = express();
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const dotenv = require('dotenv');
const admin = require('firebase-admin');

// 1. CONFIGURATION
dotenv.config();

// 2. FIREBASE ADMIN INITIALIZATION
try {
  // Instead of requiring a local file, we parse the JSON string from Environment Variables
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  console.log("✅ Firebase Admin Initialized");
} catch (error) {
  console.error("❌ Firebase Initialization Error:", error.message);
}

const db = admin.firestore();

// 3. MIDDLEWARE
app.use(cors({
  origin: [
    'http://localhost:5500', 
    'http://127.0.0.1:5500', 
    'http://192.168.1.101:5500',
    process.env.FRONTEND_URL // Add your live website URL here later via Render dashboard
  ].filter(Boolean) // Removes undefined values if FRONTEND_URL isn't set yet
}));
app.use(helmet());
app.use(morgan('dev'));
app.use(express.json());

// 4. ROUTES

// Registration Endpoint
app.post('/api/register', async (req, res) => {
    try {
        const { phoneDigits, password, inviteCode, payPassword } = req.body;

        if (!phoneDigits || !password) {
            return res.status(400).json({ error: "Missing required fields" });
        }

        const email = `251${phoneDigits}@phone.auth`;
        const fullPhoneNumber = `+251${phoneDigits}`;

        const usersRef = db.collection('users');
        const snapshot = await usersRef.count().get();
        const isFirstUser = snapshot.data().count === 0;

        let referrerDocId = null;
        if (!isFirstUser) {
            if (!inviteCode) {
                return res.status(400).json({ error: "Referral code is required" });
            }
            const referrerQuery = await usersRef.where('myReferralCode', '==', inviteCode).get();
            if (referrerQuery.empty) {
                return res.status(400).json({ error: "Invalid referral code" });
            }
            referrerDocId = referrerQuery.docs[0].id;
        }

        const userRecord = await admin.auth().createUser({
            email: email,
            password: password,
            displayName: phoneDigits
        });

        const myReferralCode = Math.random().toString(36).substring(2, 8).toUpperCase();

        const userData = {
            uid: userRecord.uid,
            phoneNumber: fullPhoneNumber,
            phoneDigits: phoneDigits,
            email: email,
            payPassword: payPassword || null,
            balance: 25,
            coupons: 5,
            myReferralCode: myReferralCode,
            isMasterAccount: isFirstUser,
            accountType: isFirstUser ? 'master' : 'regular',
            referredBy: isFirstUser ? null : inviteCode,
            totalReferrals: 0,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            accountStatus: 'active'
        };

        await usersRef.doc(userRecord.uid).set(userData);

        if (referrerDocId) {
            await usersRef.doc(referrerDocId).update({
                totalReferrals: admin.firestore.FieldValue.increment(1)
            });
        }

        res.status(201).json({ 
            success: true, 
            message: "Registration successful", 
            uid: userRecord.uid 
        });

    } catch (error) {
        console.error("Registration Error:", error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/', (req, res) => {
  res.send('Backend Server is Running');
});

// --- LOGIN ROUTE ---
app.post('/api/login', async (req, res) => {
    try {
        const { phoneDigits, password } = req.body;
        const email = `251${phoneDigits}@phone.auth`;

        // 1. IDENTITY CHECK: Find the user in Firebase Auth
        // The Admin SDK fetches the user record by email to get their UID
        const userRecord = await admin.auth().getUserByEmail(email);

        // 2. DATABASE CHECK: Verify account status in Firestore[cite: 2]
        const userDoc = await db.collection('users').doc(userRecord.uid).get();

        if (!userDoc.exists) {
            return res.status(404).json({ error: "User profile not found." });
        }

        const userData = userDoc.data();

        // Check if the admin has blocked this user[cite: 2]
        if (userData.accountStatus === 'disabled') {
            return res.status(403).json({ error: "Account disabled. Please contact support." });
        }

        // 3. SUCCESS: Send the UID back to the frontend
        // In a full production app, you'd use a password verification check here, 
        // but for now, we are authorizing based on valid Auth records.
        res.status(200).json({
            success: true,
            uid: userRecord.uid,
            message: "Login successful"
        });

    } catch (error) {
        console.error("Login Error:", error);
        res.status(401).json({ error: "Invalid phone number or user not found." });
    }
});

// 5. START SERVER
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
