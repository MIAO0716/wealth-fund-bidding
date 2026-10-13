import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AdminApp } from './pages/admin/AdminApp';
import { BidPage } from './pages/Bid';
import { JoinPage } from './pages/Join';
import { MockKdocsPage } from './pages/MockKdocs';
import { ScreenPage } from './pages/screen/ScreenPage';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/join" element={<JoinPage />} />
        <Route path="/bid" element={<BidPage />} />
        <Route path="/screen" element={<ScreenPage mode="follow" />} />
        <Route path="/screen/first-round" element={<ScreenPage mode="FIRST_ROUND" />} />
        <Route path="/screen/live" element={<ScreenPage mode="LIVE" />} />
        <Route path="/screen/results" element={<ScreenPage mode="RESULTS" />} />
        <Route path="/screen/awards" element={<ScreenPage mode="AWARDS" />} />
        <Route path="/mock-kdocs" element={<MockKdocsPage />} />
        <Route path="/admin/*" element={<AdminApp />} />
        <Route path="*" element={<Navigate to="/admin" replace />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
