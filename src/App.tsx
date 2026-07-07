import React, { useEffect, useState } from 'react';
import Dashboard from './dashboard/Dashboard';
import Widget from './widget/Widget';

const App: React.FC = () => {
  const [route, setRoute] = useState<string>('dashboard');

  useEffect(() => {
    // Basic routing using window hash
    const handleHashChange = () => {
      const hash = window.location.hash;
      if (hash === '#widget') {
        setRoute('widget');
      } else {
        setRoute('dashboard');
      }
    };

    handleHashChange();
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  return (
    <div className="h-full w-full">
      {route === 'dashboard' ? <Dashboard /> : <Widget />}
    </div>
  );
};

export default App;
