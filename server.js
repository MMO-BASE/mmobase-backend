require('dotenv').config();
const express = require('express');
const { apiLimiter, authLimiter, sensitiveLimiter } = require('./middleware/rateLimiters');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const authRoutes = require('./routes/authRoutes');
const accountRoutes = require('./routes/accountRoutes');
const characterRoutes = require('./routes/characterRoutes');
const characterDataRoutes = require('./routes/characterDataRoutes');
const { scheduleDailyAssetSnapshots } = require('./jobs/dailySnapshots');

const app = express();
app.set('trust proxy', 1);
app.use(cors({
  origin: ['https://mmobase.co.uk', 'https://v2.mmobase.co.uk'],
  credentials: true
}));
app.use(cookieParser());
app.use(express.json());

// Basic abuse protection / rate limiting

app.use('/api/account', sensitiveLimiter);
app.use('/auth/eve', authLimiter);
app.use('/callback', authLimiter);
app.use('/api/', apiLimiter);
app.use('/api/account', accountRoutes);
app.use('/api/characters', characterRoutes);
app.use('/api/character', characterDataRoutes);
app.use('/auth/', authLimiter);
app.use(authRoutes);









app.listen(process.env.PORT, () => {
  console.log('MMOBASE backend running on port ' + process.env.PORT + ' | build polish-v54-auth-safe-loading-reset-20260519_2359');
  scheduleDailyAssetSnapshots();
});
