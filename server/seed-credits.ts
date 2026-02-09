import { getUncachableStripeClient } from './stripeClient';

const CREDIT_PACKAGES = [
  { name: '5 Credits', credits: 5, price: 499, description: '5 Re-Up Spots credits for posting and applying' },
  { name: '15 Credits', credits: 15, price: 1299, description: '15 Re-Up Spots credits - Best for regular users' },
  { name: '50 Credits', credits: 50, price: 3999, description: '50 Re-Up Spots credits - Best value bulk pack' },
];

async function seedCreditProducts() {
  const stripe = await getUncachableStripeClient();

  for (const pkg of CREDIT_PACKAGES) {
    const existing = await stripe.products.search({ query: `name:'${pkg.name}'` });
    if (existing.data.length > 0) {
      console.log(`${pkg.name} already exists, skipping`);
      continue;
    }

    const product = await stripe.products.create({
      name: pkg.name,
      description: pkg.description,
      metadata: {
        type: 'credit_package',
        credits: String(pkg.credits),
      },
    });

    const price = await stripe.prices.create({
      product: product.id,
      unit_amount: pkg.price,
      currency: 'usd',
    });

    console.log(`Created: ${pkg.name} (${product.id}) - $${(pkg.price / 100).toFixed(2)} - Price: ${price.id}`);
  }

  console.log('Done seeding credit products');
}

seedCreditProducts().catch(console.error);
