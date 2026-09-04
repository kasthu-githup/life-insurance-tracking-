import express from 'express';
import path from 'path';
import dotenv from 'dotenv';
import { createServer as createViteServer } from 'vite';
import { requireAuth, AuthRequest } from './src/middleware/auth.ts';
import { getOrCreateUser, getUserProfile, updateUserProfile } from './src/db/users.ts';
import {
  getPolicies,
  getPolicyById,
  createPolicy,
  updatePolicy,
  deletePolicy,
} from './src/db/policies.ts';
import {
  getExpenses,
  createExpense,
  updateExpense,
  deleteExpense,
} from './src/db/expenses.ts';
import {
  getPayments,
  createPayment,
  recordPaymentCompletion,
} from './src/db/payments.ts';
import {
  getReminders,
  createReminder,
  markReminderRead,
  dismissReminder,
  deleteReminder,
} from './src/db/reminders.ts';
import {
  getDocuments,
  createDocument,
  deleteDocument,
} from './src/db/documents.ts';
import { seedUserDataIfEmpty } from './src/db/seed.ts';

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json());

// API Routes

// 1. Auth synchronization & onboarding
app.post('/api/auth/sync', requireAuth, async (req: AuthRequest, res) => {
  try {
    const uid = req.user!.uid;
    const email = (req.user as any)?.email || req.body.email || `${uid}@example.com`;
    const fullName = req.body.fullName || (req.user as any)?.name || 'LifeTrack User';

    const user = await getOrCreateUser(uid, email, fullName);
    await seedUserDataIfEmpty(uid, fullName);

    res.json({ success: true, user });
  } catch (error: any) {
    console.error('Error syncing auth user:', error);
    res.status(500).json({ error: error.message || 'Failed to sync user' });
  }
});

// 2. Profile endpoints
app.get('/api/profile', requireAuth, async (req: AuthRequest, res) => {
  try {
    const uid = req.user!.uid;
    let profile = await getUserProfile(uid);
    if (!profile) {
      profile = await getOrCreateUser(uid, (req.user as any)?.email || '', (req.user as any)?.name || '');
    }
    res.json(profile);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to get profile' });
  }
});

app.put('/api/profile', requireAuth, async (req: AuthRequest, res) => {
  try {
    const uid = req.user!.uid;
    const updated = await updateUserProfile(uid, req.body);
    res.json(updated);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to update profile' });
  }
});

// 3. Dashboard Analytics
app.get('/api/dashboard', requireAuth, async (req: AuthRequest, res) => {
  try {
    const uid = req.user!.uid;
    const userPolicies = await getPolicies(uid);
    const userExpenses = await getExpenses(uid);
    const userPayments = await getPayments(uid);
    const userReminders = await getReminders(uid);

    // Calculate Summary Cards
    const totalExpenses = userExpenses.reduce((sum, e) => sum + (e.amount || 0), 0);

    const now = new Date();
    const currentMonthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    const paidThisMonth = userExpenses
      .filter((e) => e.expenseDate && e.expenseDate.startsWith(currentMonthPrefix) && e.paymentStatus === 'Paid')
      .reduce((sum, e) => sum + (e.amount || 0), 0);

    const upcomingPayments = userPayments.filter((p) => p.status === 'Upcoming');
    const upcomingPremiumsAmount = upcomingPayments.reduce((sum, p) => sum + (p.amount || 0), 0);

    const overduePayments = userPayments.filter((p) => p.status === 'Overdue');
    const overduePremiumsAmount = overduePayments.reduce((sum, p) => sum + (p.amount || 0), 0);

    const activePolicies = userPolicies.filter((p) => p.status === 'Active');

    // Annualized insurance cost calculation based on frequency
    const annualInsuranceCost = activePolicies.reduce((sum, p) => {
      const amt = p.premiumAmount || 0;
      switch (p.premiumFrequency) {
        case 'Monthly':
          return sum + amt * 12;
        case 'Quarterly':
          return sum + amt * 4;
        case 'Half-Yearly':
          return sum + amt * 2;
        case 'Yearly':
        default:
          return sum + amt;
      }
    }, 0);

    // Direct vs Indirect
    const directExpenses = userExpenses.filter((e) => e.expenseType === 'Direct');
    const indirectExpenses = userExpenses.filter((e) => e.expenseType === 'Indirect');

    const directTotal = directExpenses.reduce((sum, e) => sum + (e.amount || 0), 0);
    const indirectTotal = indirectExpenses.reduce((sum, e) => sum + (e.amount || 0), 0);

    // Monthly Trend for last 6-12 months
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const monthlyTrend: Record<string, { direct: number; indirect: number; total: number; label: string }> = {};

    // Populate past 6 months
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const label = `${monthNames[d.getMonth()]} ${d.getFullYear().toString().slice(2)}`;
      monthlyTrend[key] = { direct: 0, indirect: 0, total: 0, label };
    }

    userExpenses.forEach((exp) => {
      if (exp.expenseDate && exp.expenseDate.length >= 7) {
        const key = exp.expenseDate.substring(0, 7);
        if (monthlyTrend[key]) {
          const amt = exp.amount || 0;
          if (exp.expenseType === 'Direct') {
            monthlyTrend[key].direct += amt;
          } else {
            monthlyTrend[key].indirect += amt;
          }
          monthlyTrend[key].total += amt;
        }
      }
    });

    // Policy-wise expenses
    const policyWiseMap: Record<string, number> = {};
    userExpenses.forEach((e) => {
      const name = e.policyName || 'General (Indirect)';
      policyWiseMap[name] = (policyWiseMap[name] || 0) + (e.amount || 0);
    });

    const policyWiseExpenses = Object.entries(policyWiseMap).map(([name, amount]) => ({
      name,
      amount,
    }));

    res.json({
      summary: {
        totalExpenses,
        paidThisMonth,
        upcomingPremiumsCount: upcomingPayments.length,
        upcomingPremiumsAmount,
        overdueCount: overduePayments.length,
        overdueAmount: overduePremiumsAmount,
        activePoliciesCount: activePolicies.length,
        totalPoliciesCount: userPolicies.length,
        annualInsuranceCost,
      },
      directVsIndirect: {
        directTotal,
        indirectTotal,
        directPercentage: totalExpenses > 0 ? Math.round((directTotal / totalExpenses) * 100) : 0,
        indirectPercentage: totalExpenses > 0 ? Math.round((indirectTotal / totalExpenses) * 100) : 0,
      },
      monthlyChart: Object.values(monthlyTrend),
      policyWiseExpenses,
      upcomingPayments: userPayments.slice(0, 5),
      activePolicies: activePolicies.slice(0, 4),
      reminders: userReminders.slice(0, 5),
    });
  } catch (error: any) {
    console.error('getDashboard error:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch dashboard data' });
  }
});

// 4. Policies APIs
app.get('/api/policies', requireAuth, async (req: AuthRequest, res) => {
  try {
    const list = await getPolicies(req.user!.uid);
    res.json(list);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/policies', requireAuth, async (req: AuthRequest, res) => {
  try {
    const item = await createPolicy(req.user!.uid, req.body);
    res.status(201).json(item);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/policies/:id', requireAuth, async (req: AuthRequest, res) => {
  try {
    const item = await getPolicyById(req.user!.uid, parseInt(req.params.id, 10));
    if (!item) {
      return res.status(404).json({ error: 'Policy not found' });
    }
    res.json(item);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/policies/:id', requireAuth, async (req: AuthRequest, res) => {
  try {
    const updated = await updatePolicy(req.user!.uid, parseInt(req.params.id, 10), req.body);
    res.json(updated);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/policies/:id', requireAuth, async (req: AuthRequest, res) => {
  try {
    const deleted = await deletePolicy(req.user!.uid, parseInt(req.params.id, 10));
    res.json({ success: true, deleted });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// 5. Expenses APIs
app.get('/api/expenses', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { policyId, expenseType, category, paymentStatus } = req.query;
    const list = await getExpenses(req.user!.uid, {
      policyId: policyId ? parseInt(policyId as string, 10) : undefined,
      expenseType: expenseType as string,
      category: category as string,
      paymentStatus: paymentStatus as string,
    });
    res.json(list);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/expenses', requireAuth, async (req: AuthRequest, res) => {
  try {
    const item = await createExpense(req.user!.uid, req.body);
    res.status(201).json(item);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/expenses/:id', requireAuth, async (req: AuthRequest, res) => {
  try {
    const updated = await updateExpense(req.user!.uid, parseInt(req.params.id, 10), req.body);
    res.json(updated);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/expenses/:id', requireAuth, async (req: AuthRequest, res) => {
  try {
    const deleted = await deleteExpense(req.user!.uid, parseInt(req.params.id, 10));
    res.json({ success: true, deleted });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// 6. Payments APIs
app.get('/api/payments', requireAuth, async (req: AuthRequest, res) => {
  try {
    const policyId = req.query.policyId ? parseInt(req.query.policyId as string, 10) : undefined;
    const list = await getPayments(req.user!.uid, policyId);
    res.json(list);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/payments', requireAuth, async (req: AuthRequest, res) => {
  try {
    const item = await createPayment(req.user!.uid, req.body);
    res.status(201).json(item);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/payments/:id/pay', requireAuth, async (req: AuthRequest, res) => {
  try {
    const paymentId = parseInt(req.params.id, 10);
    const paid = await recordPaymentCompletion(req.user!.uid, paymentId, req.body);
    res.json({ success: true, payment: paid });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// 7. Reminders APIs
app.get('/api/reminders', requireAuth, async (req: AuthRequest, res) => {
  try {
    const list = await getReminders(req.user!.uid);
    res.json(list);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/reminders', requireAuth, async (req: AuthRequest, res) => {
  try {
    const item = await createReminder(req.user!.uid, req.body);
    res.status(201).json(item);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/reminders/:id/read', requireAuth, async (req: AuthRequest, res) => {
  try {
    const item = await markReminderRead(req.user!.uid, parseInt(req.params.id, 10));
    res.json(item);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/reminders/:id/dismiss', requireAuth, async (req: AuthRequest, res) => {
  try {
    const item = await dismissReminder(req.user!.uid, parseInt(req.params.id, 10));
    res.json(item);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/reminders/:id', requireAuth, async (req: AuthRequest, res) => {
  try {
    const item = await deleteReminder(req.user!.uid, parseInt(req.params.id, 10));
    res.json({ success: true, item });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// 8. Documents APIs
app.get('/api/documents', requireAuth, async (req: AuthRequest, res) => {
  try {
    const policyId = req.query.policyId ? parseInt(req.query.policyId as string, 10) : undefined;
    const list = await getDocuments(req.user!.uid, policyId);
    res.json(list);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/documents', requireAuth, async (req: AuthRequest, res) => {
  try {
    const item = await createDocument(req.user!.uid, req.body);
    res.status(201).json(item);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/documents/:id', requireAuth, async (req: AuthRequest, res) => {
  try {
    const item = await deleteDocument(req.user!.uid, parseInt(req.params.id, 10));
    res.json({ success: true, item });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// 9. Reports API
app.get('/api/reports', requireAuth, async (req: AuthRequest, res) => {
  try {
    const uid = req.user!.uid;
    const allExpenses = await getExpenses(uid);
    const allPolicies = await getPolicies(uid);

    const direct = allExpenses.filter((e) => e.expenseType === 'Direct');
    const indirect = allExpenses.filter((e) => e.expenseType === 'Indirect');

    const totalExpenses = allExpenses.reduce((s, e) => s + (e.amount || 0), 0);
    const directTotal = direct.reduce((s, e) => s + (e.amount || 0), 0);
    const indirectTotal = indirect.reduce((s, e) => s + (e.amount || 0), 0);

    // Group by category
    const categoryBreakdown: Record<string, { count: number; total: number; type: string }> = {};
    allExpenses.forEach((e) => {
      const cat = e.category || 'Other';
      if (!categoryBreakdown[cat]) {
        categoryBreakdown[cat] = { count: 0, total: 0, type: e.expenseType };
      }
      categoryBreakdown[cat].count++;
      categoryBreakdown[cat].total += e.amount || 0;
    });

    // Group by policy
    const policyBreakdown: Record<string, { count: number; total: number; company: string }> = {};
    allExpenses.forEach((e) => {
      const pName = e.policyName || 'General / Unallocated';
      if (!policyBreakdown[pName]) {
        policyBreakdown[pName] = { count: 0, total: 0, company: e.companyName || 'N/A' };
      }
      policyBreakdown[pName].count++;
      policyBreakdown[pName].total += e.amount || 0;
    });

    // Group by month
    const monthlyBreakdown: Record<string, { month: string; direct: number; indirect: number; total: number }> = {};
    allExpenses.forEach((e) => {
      const m = e.expenseDate ? e.expenseDate.substring(0, 7) : 'Unknown';
      if (!monthlyBreakdown[m]) {
        monthlyBreakdown[m] = { month: m, direct: 0, indirect: 0, total: 0 };
      }
      if (e.expenseType === 'Direct') {
        monthlyBreakdown[m].direct += e.amount || 0;
      } else {
        monthlyBreakdown[m].indirect += e.amount || 0;
      }
      monthlyBreakdown[m].total += e.amount || 0;
    });

    res.json({
      summary: {
        totalExpenses,
        directTotal,
        indirectTotal,
        policyCount: allPolicies.length,
        expenseCount: allExpenses.length,
      },
      categoryBreakdown: Object.entries(categoryBreakdown).map(([category, data]) => ({
        category,
        ...data,
      })),
      policyBreakdown: Object.entries(policyBreakdown).map(([policyName, data]) => ({
        policyName,
        ...data,
      })),
      monthlyBreakdown: Object.values(monthlyBreakdown).sort((a, b) => b.month.localeCompare(a.month)),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Vite middleware & Static serving
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
