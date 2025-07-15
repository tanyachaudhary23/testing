require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3000;

if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// Multer configuration for image upload
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/');
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed!'), false);
    }
  }
});

//Initialize all database tables
async function initializeDatabase() {
  try {
    // Users table
        await pool.query(`
          CREATE TABLE IF NOT EXISTS users (
            id UUID PRIMARY KEY,
            full_name TEXT,
            email TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            user_type TEXT NOT NULL,
            account_type TEXT,
            mobile_number VARCHAR(15),
            ngo_id VARCHAR(100),
            dob DATE,
            address TEXT,
            city TEXT,
            pincode VARCHAR(10),
            country TEXT,
            occupation TEXT,
            CONSTRAINT chk_mobile_length CHECK (
              mobile_number IS NULL OR 
              (char_length(mobile_number) = 10 AND mobile_number ~ '^[0-9]+$')
            )
          )
        `);


    // Campaigns table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS campaigns (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title VARCHAR(255) NOT NULL,
        description TEXT NOT NULL,
        target_amount DECIMAL(10,2) NOT NULL,
        raised_amount DECIMAL(10,2) DEFAULT 0,
        creator_name VARCHAR(255) NOT NULL,
        image VARCHAR(255) NOT NULL,
        days_left INTEGER NOT NULL,
        supporters INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Donations table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS donations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        campaign_id UUID REFERENCES campaigns(id) ON DELETE CASCADE,
        donor_name VARCHAR(255) NOT NULL,
        amount DECIMAL(10,2) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log('Database tables initialized successfully');
  } catch (err) {
    console.error('Database initialization error:', err);
  }
}

//Call the database initializer at startup
initializeDatabase();

//Signup Route
app.post('/signup', async (req, res) => {
  const {
    full_name,
    mobile_number,
    email,
    password,
    dob,
    address,
    city,
    pincode,
    country,
    occupation,
    user_type,      // 'campaign_owner' or 'user'
    account_type,   // 'individual' or 'organization'
    ngo_id,
    
  } = req.body;

  try {
    const userCheck = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (userCheck.rows.length > 0) {
      return res.json({ success: false, message: 'Email already registered.' });
    }

    const id = uuidv4();
    const password_hash = await bcrypt.hash(password, 10);

    // Insert into users table
    await pool.query(
      `INSERT INTO users 
        (id, full_name, email, password_hash, user_type, account_type, mobile_number, ngo_id, dob, address, city, pincode, country, occupation)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        id,
        full_name,
        email,
        password_hash,
        user_type,
        user_type === 'user' ? null : account_type ,
        mobile_number || null,                                
        account_type === 'organization' ? ngo_id : null ,
        user_type === 'user' ? dob : null ,
        address,
        user_type === 'user' ? null : city ,
        user_type === 'user' ? null : pincode ,
        user_type === 'user' ? null : country ,
        user_type === 'user' ? occupation : null ,     
      ]
    );

    res.json({ success: true, message: 'Signup successful!' });

  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ success: false, message: 'Server error during signup.' });
  }
});

//Login Route
app.post('/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);

    if (result.rows.length === 0) {
      return res.json({ success: false, message: 'Invalid email!' });
    }

    const user = result.rows[0];
    const isValid = await bcrypt.compare(password, user.password_hash);

    if (isValid) {
      res.json({ success: true, message: 'Login successful' });
    } else {
      res.json({ success: false, message: 'Invalid email or password' });
    }

  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ success: false, message: 'Server error during login.' });
  }
});

// CROWDFUNDING ROUTES

// Get all campaigns with progress calculation
app.get('/api/campaigns', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        id,
        title,
        description,
        target_amount,
        raised_amount,
        creator_name,
        image,
        days_left,
        supporters,
        created_at,
        ROUND((raised_amount / target_amount * 100)::numeric, 2) as progress_percentage
      FROM campaigns 
      ORDER BY created_at DESC
    `);

    res.json({
      success: true,
      campaigns: result.rows
    });
  } catch (err) {
    console.error('Get campaigns error:', err);
    res.status(500).json({ success: false, message: 'Server error fetching campaigns.' });
  }
});

// Get single campaign with progress
app.get('/api/campaigns/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(`
      SELECT 
        id,
        title,
        description,
        target_amount,
        raised_amount,
        creator_name,
        image,
        days_left,
        supporters,
        created_at,
        ROUND((raised_amount / target_amount * 100)::numeric, 2) as progress_percentage
      FROM campaigns 
      WHERE id = $1
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Campaign not found' });
    }

    res.json({
      success: true,
      campaign: result.rows[0]
    });
  } catch (err) {
    console.error('Get campaign error:', err);
    res.status(500).json({ success: false, message: 'Server error fetching campaign.' });
  }
});

// Create new campaign
app.post('/api/campaigns', upload.single('image'), async (req, res) => {
  try {
    const {
      title,
      description,
      target_amount,
      creator_name,
      days_left
    } = req.body;

    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Image is required' });
    }

    const image = req.file.filename;

    const result = await pool.query(`
      INSERT INTO campaigns (title, description, target_amount, creator_name, image, days_left)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id
    `, [title, description, target_amount, creator_name, image, days_left]);

    res.json({
      success: true,
      message: 'Campaign created successfully',
      campaign_id: result.rows[0].id
    });
  } catch (err) {
    console.error('Create campaign error:', err);
    res.status(500).json({ success: false, message: 'Server error creating campaign.' });
  }
});




// Make donation to campaign
app.post('/api/campaigns/:id/donate', async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { id } = req.params;
    const { donor_name, amount } = req.body;

    await client.query('BEGIN');

    // Check if campaign exists
    const campaignCheck = await client.query('SELECT * FROM campaigns WHERE id = $1', [id]);
    if (campaignCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Campaign not found' });
    }

    // Insert donation
    await client.query(`
      INSERT INTO donations (campaign_id, donor_name, amount)
      VALUES ($1, $2, $3)
    `, [id, donor_name, amount]);

    // Update campaign raised amount and supporters count
    await client.query(`
      UPDATE campaigns 
      SET raised_amount = raised_amount + $1,
          supporters = supporters + 1
      WHERE id = $2
    `, [amount, id]);

    await client.query('COMMIT');

    // Get updated campaign info
    const updatedCampaign = await client.query(`
      SELECT 
        raised_amount,
        target_amount,
        supporters,
        ROUND((raised_amount / target_amount * 100)::numeric, 2) as progress_percentage
      FROM campaigns 
      WHERE id = $1
    `, [id]);

    res.json({
      success: true,
      message: 'Donation successful',
      campaign: updatedCampaign.rows[0]
    });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Donation error:', err);
    res.status(500).json({ success: false, message: 'Server error processing donation.' });
  } finally {
    client.release();
  }
});



// Get campaign donations
app.get('/api/campaigns/:id/donations', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(`
      SELECT donor_name, amount, created_at
      FROM donations 
      WHERE campaign_id = $1
      ORDER BY created_at DESC
    `, [id]);

    res.json({
      success: true,
      donations: result.rows
    });
  } catch (err) {
    console.error('Get donations error:', err);
    res.status(500).json({ success: false, message: 'Server error fetching donations.' });
  }
});

































































// Update campaign progress (for testing purposes)
app.put('/api/campaigns/:id/progress', async (req, res) => {
  try {
    const { id } = req.params;
    const { raised_amount } = req.body;

    const result = await pool.query(`
      UPDATE campaigns 
      SET raised_amount = $1
      WHERE id = $2
      RETURNING 
        raised_amount,
        target_amount,
        ROUND((raised_amount / target_amount * 100)::numeric, 2) as progress_percentage
    `, [raised_amount, id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Campaign not found' });
    }

    res.json({
      success: true,
      message: 'Progress updated successfully',
      campaign: result.rows[0]
    });
  } catch (err) {
    console.error('Update progress error:', err);
    res.status(500).json({ success: false, message: 'Server error updating progress.' });
  }
});

// DUMMY DATA ENDPOINTS FOR TESTING

// Add dummy campaigns
app.post('/api/dummy/campaigns', async (req, res) => {
  try {
    const dummyCampaigns = [
      {
        title: "Help 3-Year-Old Hansika Hear the World! Donate to Her Treatment",
        description: "Little Hansika was born with severe hearing loss. With your support, she can get the cochlear implant surgery she needs to hear her mother's voice for the first time.",
        target_amount: 3400000,
        raised_amount: 757774,
        creator_name: "Krishan",
        image: "hansika-campaign.jpg",
        days_left: 22,
        supporters: 457
      },
      {
        title: "My Mother Is Fighting For Her Life And We Need Your Support To Save Her",
        description: "My mother has been diagnosed with a critical illness and is currently in the ICU. The medical expenses are overwhelming and we need your help to continue her treatment.",
        target_amount: 2000000,
        raised_amount: 927962,
        creator_name: "Feroz Basha Khan Pathan",
        image: "mother-treatment.jpg",
        days_left: 4,
        supporters: 248
      },
      {
        title: "Save Little Shanaya's Life From the Clutches of a Brain Infection",
        description: "2-year-old Shanaya is fighting a severe brain infection. She needs immediate medical intervention and your support can help save her precious life.",
        target_amount: 3000000,
        raised_amount: 666468,
        creator_name: "Shazia Azeez",
        image: "shanaya-brain.jpg",
        days_left: 22,
        supporters: 426
      },
      {
        title: "Emergency Heart Surgery Required for 8-Year-Old Arjun",
        description: "Arjun was born with a congenital heart defect. He urgently needs open heart surgery to live a normal life. Your donation can give him a second chance at life.",
        target_amount: 4500000,
        raised_amount: 1250000,
        creator_name: "Priya Sharma",
        image: "arjun-heart.jpg",
        days_left: 15,
        supporters: 672
      },
      {
        title: "Help Rebuild Homes After Devastating Flood",
        description: "A recent flood has destroyed 200+ homes in our village. Families are left with nothing. Help us rebuild their lives and provide them with basic necessities.",
        target_amount: 5000000,
        raised_amount: 2100000,
        creator_name: "Village Development Committee",
        image: "flood-relief.jpg",
        days_left: 30,
        supporters: 1234
      },
      {
        title: "Education Fund for Underprivileged Children",
        description: "Support quality education for 50 underprivileged children in rural areas. Your contribution will cover books, uniforms, and school fees for one academic year.",
        target_amount: 1500000,
        raised_amount: 890000,
        creator_name: "Education Trust NGO",
        image: "education-fund.jpg",
        days_left: 18,
        supporters: 567
      }
    ];

    const insertedCampaigns = [];
    
    for (const campaign of dummyCampaigns) {
      const result = await pool.query(`
        INSERT INTO campaigns (title, description, target_amount, raised_amount, creator_name, image, days_left, supporters)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *
      `, [
        campaign.title,
        campaign.description,
        campaign.target_amount,
        campaign.raised_amount,
        campaign.creator_name,
        campaign.image,
        campaign.days_left,
        campaign.supporters
      ]);
      
      insertedCampaigns.push(result.rows[0]);
    }

    res.json({
      success: true,
      message: `${insertedCampaigns.length} dummy campaigns created successfully`,
      campaigns: insertedCampaigns
    });
  } catch (err) {
    console.error('Create dummy campaigns error:', err);
    res.status(500).json({ success: false, message: 'Server error creating dummy campaigns.' });
  }
});

// Add dummy donations
app.post('/api/dummy/donations', async (req, res) => {
  try {
    // First get all campaign IDs
    const campaignsResult = await pool.query('SELECT id FROM campaigns');
    const campaignIds = campaignsResult.rows.map(row => row.id);
    
    if (campaignIds.length === 0) {
      return res.status(400).json({ success: false, message: 'No campaigns found. Create campaigns first.' });
    }

    const dummyDonations = [
      { donor_name: "Rahul Verma", amount: 5000 },
      { donor_name: "Priya Singh", amount: 10000 },
      { donor_name: "Amit Kumar", amount: 2500 },
      { donor_name: "Sneha Patel", amount: 7500 },
      { donor_name: "Vikram Sharma", amount: 15000 },
      { donor_name: "Anjali Gupta", amount: 3000 },
      { donor_name: "Ravi Mehta", amount: 8000 },
      { donor_name: "Kavya Reddy", amount: 12000 },
      { donor_name: "Arjun Nair", amount: 6000 },
      { donor_name: "Deepika Joshi", amount: 9000 },
      { donor_name: "Sanjay Yadav", amount: 4000 },
      { donor_name: "Pooja Agarwal", amount: 11000 },
      { donor_name: "Manoj Tiwari", amount: 7000 },
      { donor_name: "Ritika Bansal", amount: 13000 },
      { donor_name: "Gaurav Malhotra", amount: 5500 }
    ];

    const insertedDonations = [];

    for (const donation of dummyDonations) {
      // Randomly assign to a campaign
      const randomCampaignId = campaignIds[Math.floor(Math.random() * campaignIds.length)];
      
      const result = await pool.query(`
        INSERT INTO donations (campaign_id, donor_name, amount)
        VALUES ($1, $2, $3)
        RETURNING *
      `, [randomCampaignId, donation.donor_name, donation.amount]);
      
      insertedDonations.push(result.rows[0]);
    }

    res.json({
      success: true,
      message: `${insertedDonations.length} dummy donations created successfully`,
      donations: insertedDonations
    });
  } catch (err) {
    console.error('Create dummy donations error:', err);
    res.status(500).json({ success: false, message: 'Server error creating dummy donations.' });
  }
});

// Clear all dummy data
app.delete('/api/dummy/clear', async (req, res) => {
  try {
    await pool.query('DELETE FROM donations');
    await pool.query('DELETE FROM campaigns');
    
    res.json({
      success: true,
      message: 'All dummy data cleared successfully'
    });
  } catch (err) {
    console.error('Clear dummy data error:', err);
    res.status(500).json({ success: false, message: 'Server error clearing dummy data.' });
  }
});

// Get database statistics
app.get('/api/dummy/stats', async (req, res) => {
  try {
    const campaignsCount = await pool.query('SELECT COUNT(*) FROM campaigns');
    const donationsCount = await pool.query('SELECT COUNT(*) FROM donations');
    const totalRaised = await pool.query('SELECT SUM(raised_amount) FROM campaigns');
    const totalDonated = await pool.query('SELECT SUM(amount) FROM donations');
    
    res.json({
      success: true,
      stats: {
        total_campaigns: parseInt(campaignsCount.rows[0].count),
        total_donations: parseInt(donationsCount.rows[0].count),
        total_raised_in_campaigns: parseFloat(totalRaised.rows[0].sum) || 0,
        total_donated_amount: parseFloat(totalDonated.rows[0].sum) || 0
      }
    });
  } catch (err) {
    console.error('Get stats error:', err);
    res.status(500).json({ success: false, message: 'Server error getting stats.' });
  }
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});