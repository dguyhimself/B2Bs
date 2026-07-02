import { Pool } from 'pg';
import bcrypt from 'bcrypt';

// Initialize DB connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { fullName, country, phoneNumber, password, referralCode } = req.body;

  // 1. Basic Validation
  if (!fullName || !country || !phoneNumber || !password || !referralCode) {
    return res.status(400).json({ error: 'All fields, including Partner ID, are required.' });
  }

  try {
    // 2. Verify the Partner ID (referralCode) exists in the database
    const sponsorCheck = await pool.query('SELECT id FROM users WHERE partner_id = $1',[referralCode]);

    if (sponsorCheck.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid Partner ID. Registration requires a valid sponsor.' });
    }

    // 3. Check if phone number is already registered
    const phoneCheck = await pool.query('SELECT id FROM users WHERE phone_number = $1', [phoneNumber]);
    if (phoneCheck.rows.length > 0) {
      return res.status(400).json({ error: 'Phone number already registered to an agency.' });
    }

    // 4. Hash the password for security
    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    // 5. Generate a unique Partner ID for the new user (e.g., APX-89324)
    const newPartnerId = 'APX-' + Math.floor(10000 + Math.random() * 90000);

    // 6. Insert new user into the database
    const insertQuery = `
      INSERT INTO users (full_name, country, phone_number, password_hash, partner_id, referred_by)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, full_name, partner_id;
    `;
    const values =[fullName, country, phoneNumber, passwordHash, newPartnerId, referralCode];

    const newUser = await pool.query(insertQuery, values);

    // 7. Success Response
    return res.status(201).json({ 
      message: 'Agency Node Registered Successfully', 
      user: newUser.rows[0] 
    });

  } catch (error) {
    console.error('Registration Error:', error);
    return res.status(500).json({ error: 'Internal server error during node allocation.' });
  }
}