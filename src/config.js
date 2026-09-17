export const CONFIG = {
  OXYGEN_MAX: 100,
  OXYGEN_DEPLETION_RATE: 0.35, // oxygen lost per second (~180s total dive)
  OXYGEN_REFILL_POD_VALUE: 35,
  
  GAZE_TIME_REQUIRED: 1.8, // seconds looking at target to interact
  SWIM_SPEED: 5.5,
  
  IPD: 0.064, // Interpupillary distance for SBS VR
  
  TARGET_SPECIES_COUNT: 5,
  TARGET_POLLUTION_COUNT: 4,
  
  SPECIES: [
    { id: 'clownfish', name: 'Clownfish', desc: 'Small reef dweller immune to sea anemone stings.' },
    { id: 'turtle', name: 'Green Sea Turtle', desc: 'Ancient ocean traveler endangered by plastic waste.' },
    { id: 'jellyfish', name: 'Bioluminescent Jelly', desc: 'Pulsating organism producing cool blue luminescence.' },
    { id: 'octopus', name: 'Reef Octopus', desc: 'Master of camouflage and high marine intelligence.' },
    { id: 'manta', name: 'Giant Manta Ray', desc: 'Graceful filter feeder gliding through ocean currents.' },
    { id: 'shark', name: 'Great White Shark', desc: 'Apex ocean predator observing from a safe distance.' }
  ],

  POLLUTION: [
    { id: 'p_bottle', name: 'Plastic Bottle' },
    { id: 'p_net', name: 'Discarded Net' },
    { id: 'p_metal', name: 'Rust Can' },
    { id: 'p_barrel', name: 'Toxic Barrel' }
  ]
};